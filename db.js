const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MongoClient, GridFSBucket } = require('mongodb');
const bcrypt = require('bcryptjs');

const MAX_ADMIN_USERS = 1;
const LOCAL_DB_PATH = path.join(__dirname, 'database.json');
const BUCKET_NAME = 'documentos';

const COLLECTIONS = {
  users: 'users',
  employees: 'employees',
  documents: 'documents',
  documentTypes: 'documentTypes',
  categories: 'categories',
  auditLogs: 'auditLogs',
  emailsInbox: 'emailsInbox',
  deletionRequests: 'deletionRequests',
  activationTokens: 'activationTokens',
  passwordResetTokens: 'passwordResetTokens',
  loginAttempts: 'loginAttempts',
  securityLogs: 'securityLogs'
};

const MONGO_OPTIONS = {
  serverSelectionTimeoutMS: 30000,
  heartbeatFrequencyMS: 8000,
  socketTimeoutMS: 15000,
  connectTimeoutMS: 15000,
  family: 4,
  maxPoolSize: 5,
  minPoolSize: 1,
  maxIdleTimeMS: 30000,
  retryWrites: true,
  retryReads: true
};

// Contraseña temporal de un solo uso: evita sembrar contraseñas conocidas (ej. "admin").
function generateTempPassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^&*_-+=?';
  const pick = (set, n) => Array.from({ length: n }, () => set[crypto.randomInt(set.length)]).join('');
  return pick(upper, 2) + pick(lower, 2) + pick(digits, 2) + pick(symbols, 2) + pick(upper + lower + digits + symbols, 8);
}

function buildUri(uri) {
  // retryWrites ya se configura en MONGO_OPTIONS; aquí solo se garantiza w=majority
  // y se normaliza la query para evitar '?&' malformado.
  const trimmed = uri.split('?')[0];
  const query = uri.split('?')[1] || '';
  const baseParams = ['w=majority'];
  const params = new Set(query.split('&').filter(Boolean).map(p => p.split('=')[0]));
  const missing = baseParams.filter(p => !params.has(p.split('=')[0]));
  if (!missing.length) return trimmed + (query ? '?' + query : '');
  return trimmed + '?' + (query ? query + '&' : '') + missing.join('&');
}

let client = null;
let db = null;
let initPromise = null;
let bucket = null;
let reconnectInProgress = false;

// col() seguro que no falla si db es null momentáneamente durante reconexión
function col(name) {
  if (!db) throw new Error('Database not connected');
  if (!COLLECTIONS[name]) throw new Error(`Invalid collection name: ${name}`);
  return db.collection(COLLECTIONS[name]);
}

function enforceSingleAdmin(users) {
  const admins = users.filter(u => u.role === 'admin');
  if (admins.length <= MAX_ADMIN_USERS) return users;
  console.warn(`[SEGU] Se detectaron ${admins.length} administradores. Solo se permite ${MAX_ADMIN_USERS}. Se eliminan los extras.`);
  const keep = admins[0];
  return [keep, ...users.filter(u => u.role !== 'admin')];
}

function readLocalSeed() {
  try {
    if (!fs.existsSync(LOCAL_DB_PATH)) return null;
    return JSON.parse(fs.readFileSync(LOCAL_DB_PATH, 'utf8'));
  } catch (error) {
    console.error('Error al leer database.json local:', error);
    return null;
  }
}

async function runMigrations() {
  for (let migAttempt = 1; migAttempt <= 2; migAttempt++) {
    try {
      const docsRes = await db.collection(COLLECTIONS.documents).updateMany(
        { visibleToEmployee: { $exists: false } },
        { $set: { visibleToEmployee: true, uploadedByEmployee: false } }
      );
      const empsRes = await db.collection(COLLECTIONS.employees).updateMany(
        { active: { $exists: false } },
        { $set: { active: true } }
      );
      const usersRes = await db.collection(COLLECTIONS.users).updateMany(
        { status: { $exists: false } },
        { $set: { status: 'activa', failedAttempts: 0, lockedUntil: null } }
      );
      const empsStatusRes = await db.collection(COLLECTIONS.employees).updateMany(
        { status: { $exists: false } },
        { $set: { status: 'activa', failedAttempts: 0, lockedUntil: null } }
      );
      const docsModified = docsRes.modifiedCount;
      const empsModified = empsRes.modifiedCount;
      const usersMigrated = usersRes.modifiedCount;
      const empsStatusMigrated = empsStatusRes.modifiedCount;
      if (docsModified > 0) console.log(`Migración: ${docsModified} documentos actualizados con visibleToEmployee=true`);
      if (empsModified > 0) console.log(`Migración: ${empsModified} funcionarios actualizados con active=true`);
      if (usersMigrated > 0) console.log(`Migración: ${usersMigrated} usuarios admin migrados con status=activa`);
      if (empsStatusMigrated > 0) console.log(`Migración: ${empsStatusMigrated} funcionarios migrados con status=activa`);
      break;
    } catch (e) {
      if (migAttempt < 2) { await new Promise(r => setTimeout(r, 1000)); continue; }
      else { console.error('Error en migraciones retroactivas (tras retry):', e.message); }
    }
  }
}

// Crea un índice; si ya existe uno con la misma key pero opciones distintas
// (p.ej. TTL cambiado), lo elimina primero para que MongoDB no rechace la
// creación por conflicto de nombre (IndexOptionsConflict).
async function ensureIndex(coll, keys, opts) {
  const collection = db.collection(coll);
  let existing = null;
  try {
    const wanted = JSON.stringify(keys);
    const indexes = await collection.indexes();
    for (const idx of indexes) {
      if (idx.key && JSON.stringify(idx.key) === wanted) { existing = idx; break; }
    }
  } catch (e) { existing = null; }

  if (existing && !existing.name.startsWith('_id_')) {
    const requestedName = opts.name || Object.keys(keys).map(k => `${k}_${keys[k]}`).join('_');
    const sameOptions = (existing.expireAfterSeconds || null) === (opts.expireAfterSeconds || null) &&
      (!!existing.unique) === (!!opts.unique);
    if (!sameOptions || (opts.name && existing.name !== opts.name)) {
      await collection.dropIndex(existing.name);
    }
  }

  return collection.createIndex(keys, opts);
}

async function ensureIndexes() {
  const errors = [];
  const attempts = [
    [COLLECTIONS.loginAttempts, { identifier: 1, timestamp: -1 }, {}],
    [COLLECTIONS.loginAttempts, { timestamp: 1 }, { expireAfterSeconds: 1800 }],
    [COLLECTIONS.passwordResetTokens, { expiresAt: 1 }, { expireAfterSeconds: 0 }],
    [COLLECTIONS.activationTokens, { expiresAt: 1 }, { expireAfterSeconds: 0 }],
    [COLLECTIONS.documents, { employeeId: 1 }, {}],
    [COLLECTIONS.documents, { filename: 1 }, {}],
    [COLLECTIONS.documents, { id: 1 }, { unique: true, name: 'uniq_doc_id' }],
    [COLLECTIONS.users, { email: 1 }, { unique: true }],
    [COLLECTIONS.employees, { id: 1 }, { unique: true, name: 'uniq_emp_id' }],
    [COLLECTIONS.employees, { email: 1 }, { unique: true, name: 'uniq_emp_email' }],
    [COLLECTIONS.auditLogs, { timestamp: -1 }, {}],
    [COLLECTIONS.emailsInbox, { id: 1 }, { unique: true, sparse: true }]
  ];
  for (const [coll, keys, opts] of attempts) {
    try {
      await ensureIndex(coll, keys, opts);
    } catch (e) {
      errors.push(`${coll}: ${e.message}`);
    }
  }
  if (errors.length > 0) {
    console.error('[MONGO] Fallaron índices: ' + errors.join(' | '));
    try {
      await db.collection(COLLECTIONS.securityLogs).insertOne({
        id: 'sec_index_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'),
        timestamp: new Date().toISOString(),
        event: 'INDICES_FALLIDOS',
        details: 'Fallo creando índices: ' + errors.join(' | '),
        ip: 'local',
        email: 'sistema',
        severity: 'high'
      });
    } catch (_) {}
  }
  return errors.length === 0;
}

async function connect() {
  let uri = process.env.DATABASE_URL;
  if (!uri) {
    throw new Error('DATABASE_URL no está configurada. La base de datos debe ser remota.');
  }

  if (db) return db;

  if (!initPromise) {
    initPromise = (async () => {
      uri = buildUri(uri);

      // TLS: verificación de certificados activa por defecto (sin tlsAllowInvalidCertificates)

      const MAX_RETRIES = 7;
      let lastError;
      let newClient = null;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          newClient = new MongoClient(uri, MONGO_OPTIONS);
          newClient.on('error', (err) => {
            console.warn('[MONGO] Error en el pool de conexiones:', err.message);
          });
          await newClient.connect();
          await newClient.db('admin').command({ ping: 1 });
          break;
        } catch (err) {
          lastError = err;
          console.warn(`Intento ${attempt}/${MAX_RETRIES} de conexión a MongoDB falló: ${err.message}`);
          if (newClient) { try { await newClient.close(true); } catch (_) {} newClient = null; }
          if (attempt < MAX_RETRIES) {
            const delay = 1000 + Math.random() * 1500;
            await new Promise(r => setTimeout(r, delay));
          }
        }
      }
      if (!newClient) {
        throw lastError;
      }

      // Intercambio atómico al final: durante los reintentos no se toca `client` global,
      // así `reconnect()` no pierde su cliente recién creado (race corregida).
      const dbName = process.env.DATABASE_NAME || 'talento_humano';
      db = newClient.db(dbName);
      bucket = new GridFSBucket(db, { bucketName: BUCKET_NAME });
      const oldClient = client;
      client = newClient;
      if (oldClient) setTimeout(() => { try { oldClient.close(false); } catch (_) {} }, 10000);

      // Sembrar desde database.json local si las colecciones están vacías
      // Crear índices ANTES del seed para que users.email (único) evite duplicados (race en arranque)
      await ensureIndexes();

      const usersCount = await db.collection(COLLECTIONS.users).countDocuments();
      if (usersCount === 0) {
        const seed = readLocalSeed();
        console.log('Poblando MongoDB desde database.json de referencia...');

        // Usuarios: garantiza al menos un admin aunque no exista database.json
        let seedUsers = (seed && Array.isArray(seed.users) && seed.users.length > 0) ? seed.users : [{
          email: 'talentohumanova23@gmail.com',
          name: 'Administrador Talento Humano',
          role: 'admin',
          department: 'Talento Humano',
          active: true
        }];

        // Sin contraseña definida => contraseña temporal aleatoria (nunca una conocida).
        // Se marca mustChangePassword para forzar el cambio en el primer inicio.
        const tempPasswords = new Map();
        for (const u of seedUsers) {
          if (!u.password) {
            const temp = generateTempPassword();
            u.password = await bcrypt.hash(temp, 12);
            u.mustChangePassword = true;
            tempPasswords.set(u.email, temp);
          }
        }

        seedUsers = enforceSingleAdmin(seedUsers);
        if (seedUsers.length > 0) {
          try {
            await db.collection(COLLECTIONS.users).insertMany(seedUsers);
          } catch (e) {
            console.error('[SEED] Fallo insertando usuarios:', e.message);
          }
        }

        if (tempPasswords.size > 0) {
          for (const [email, temp] of tempPasswords) {
            console.warn(`[SEED] Contraseña temporal para ${email}: ${temp}`);
          }
          try {
            await db.collection(COLLECTIONS.securityLogs).insertOne({
              id: 'sec_seed_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'),
              timestamp: new Date().toISOString(),
              event: 'SEED_INIT',
              details: `Base de datos inicializada. Se generaron contraseñas temporales para ${tempPasswords.size} usuario(s) sin contraseña definida (deben cambiarse en el primer inicio).`,
              ip: 'local',
              email: 'sistema',
              severity: 'warning'
            });
          } catch (_) {}
        }

        // Empleados y catálogos: cada colección se inserta de forma aislada para que
        // un fallo (p. ej. E11000 por datos duplicados de database.json) no deje la BD
        // parcialmente sembrada sin recuperación.
        const seedCollection = async (name, data) => {
          if (data && Array.isArray(data) && data.length > 0) {
            try {
              await db.collection(name).insertMany(data);
            } catch (e) {
              console.error(`[SEED] Fallo insertando '${name}':`, e.message);
            }
          }
        };
        await seedCollection(COLLECTIONS.employees, seed && seed.employees);
        await seedCollection(COLLECTIONS.documentTypes, seed && seed.documentTypes);
        await seedCollection(COLLECTIONS.categories, seed && seed.categories);
        await seedCollection(COLLECTIONS.documents, seed && seed.documents);
        await seedCollection(COLLECTIONS.auditLogs, seed && seed.auditLogs);
        await seedCollection(COLLECTIONS.emailsInbox, seed && seed.emailsInbox);

        console.log('Base de datos poblada exitosamente.');
      } else {
        // No reasignar contraseñas en arranque (anti-backdoor). Solo se alerta en securityLogs.
        const adminUser = await db.collection(COLLECTIONS.users).findOne({ role: 'admin' });
        if (adminUser && !adminUser.password) {
          console.warn('[SEGU] El administrador no tiene contraseña definida. No se asignó ninguna por defecto por seguridad.');
          try {
            await db.collection(COLLECTIONS.securityLogs).insertOne({
              id: 'sec_nopw_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'),
              timestamp: new Date().toISOString(),
              event: 'ADMIN_SIN_PASSWORD',
              details: 'Se detectó un usuario admin sin contraseña. No se reasignó automáticamente. Configure una contraseña manualmente.',
              ip: 'local',
              email: adminUser.email || 'unknown',
              severity: 'high'
            });
          } catch (_) {}
        }
      }

      // Migraciones retroactivas (con retry ante TLS inestable)
      await runMigrations();

      // Integridad: verificar el número de administradores y registrar divergencias
      const adminCount = await db.collection(COLLECTIONS.users).countDocuments({ role: 'admin' });
      if (adminCount !== 1) {
        console.warn(`[SEGU] Se encontraron ${adminCount} administrador(es). Solo se permite 1. Revise la colección 'users'.`);
        try {
          await db.collection(COLLECTIONS.securityLogs).insertOne({
            id: 'sec_admins_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'),
            timestamp: new Date().toISOString(),
            event: 'ADMIN_COUNT_INVALIDO',
            details: `Se detectaron ${adminCount} administradores en la colección users.`,
            ip: 'local',
            email: 'sistema',
            severity: 'high'
          });
        } catch (_) {}
      }

      return db;
    })().catch(error => {
      initPromise = null;
      throw error;
    });
  }

  return initPromise;
}

// Verificar salud de la conexión (ping acotado a 4 s para no superponer sondeos)
async function isHealthy() {
  try {
    if (!client || !db) return false;
    const pong = await Promise.race([
      client.db('admin').command({ ping: 1 }).then(() => true, () => false),
      new Promise(resolve => setTimeout(() => resolve(false), 4000))
    ]);
    return pong === true;
  } catch (e) {
    return false;
  }
}

// --- GRIDFS HELPERS ---
function getBucket() {
  if (!bucket) throw new Error('GridFS no inicializado');
  return bucket;
}

function storeFileBuffer(filename, buffer, metadata = {}) {
  return new Promise((resolve, reject) => {
    const us = getBucket().openUploadStream(filename, { metadata });
    const onErr = (err) => { try { us.destroy(); } catch (_) {} reject(err); };
    us.on('finish', () => resolve(us.id));
    us.on('error', onErr);
    us.end(buffer);
  });
}

function storeFileStream(filename, stream, metadata = {}) {
  return new Promise((resolve, reject) => {
    const us = getBucket().openUploadStream(filename, { metadata });
    const onErr = (err) => { try { us.destroy(); stream.destroy(); } catch (_) {} reject(err); };
    us.on('finish', () => resolve(us.id));
    us.on('error', onErr);
    stream.on('error', onErr);
    stream.pipe(us);
  });
}

async function readFileStream(filename) {
  try {
    const bucket = getBucket();
    const cursor = bucket.find({ filename }).sort({ uploadDate: -1 }).limit(1);
    const file = await cursor.next();
    if (!file) return null;
    const stream = bucket.openDownloadStream(file._id);
    // Capturar errores del stream GridFS antes de que escapen al uncaughtException
    stream.on('error', (err) => {
      console.error(`[GRIDFS] Error en download stream '${filename}':`, err.message);
    });
    return { stream, file };
  } catch (err) {
    console.error(`[GRIDFS] Error en readFileStream('${filename}'):`, err.message);
    return null;
  }
}

async function deleteFileByName(filename) {
  const bucket = getBucket();
  const cursor = bucket.find({ filename });
  const files = await cursor.toArray();
  for (const f of files) {
    try { await bucket.delete(f._id); } catch (_) {}
  }
}

async function listFilesBySource(source, registered = false) {
  const bucket = getBucket();
  return bucket.find({ 'metadata.source': source, 'metadata.registered': registered })
    .sort({ uploadDate: -1 }).toArray();
}

async function markFileRegistered(filename) {
  const bucket = getBucket();
  const collection = db.collection(`${BUCKET_NAME}.files`);
  // Marca TODOS los archivos con ese nombre (no solo el primero), ordenados por más reciente,
  // para que un escaneo duplicado quede registrado y no vuelva a aparecer como pendiente.
  const res = await collection.updateMany(
    { filename, 'metadata.registered': { $ne: true } },
    { $set: { 'metadata.registered': true } }
  );
  if (res.matchedCount === 0) throw new Error(`Archivo '${filename}' no encontrado en GridFS`);
}

async function closeDb() {
  try {
    if (client) await client.close(true);
  } catch (_) {}
  client = null;
  db = null;
  bucket = null;
  initPromise = null;
}

module.exports = {
  connect,
  col,
  isHealthy,
  closeDb,
  storeFileBuffer,
  readFileStream,
  deleteFileByName,
  listFilesBySource,
  markFileRegistered,
  reconnect: async function() {
    if (reconnectInProgress) return false;
    reconnectInProgress = true;
    let newClient = null;
    try {
      const uri = process.env.DATABASE_URL;
      if (!uri) return false;
      const fullUri = buildUri(uri);

      newClient = new MongoClient(fullUri, MONGO_OPTIONS);
      newClient.on('error', err => console.warn('[MONGO] Error de pool en reconexión:', err.message || err));

      await newClient.connect();
      await newClient.db('admin').command({ ping: 1 });
      const newDb = newClient.db(process.env.DATABASE_NAME || 'talento_humano');

      const oldClient = client;
      client = newClient;
      db = newDb;
      bucket = new GridFSBucket(db, { bucketName: BUCKET_NAME });
      initPromise = null;

      await runMigrations().catch(() => {});
      await ensureIndexes().catch(() => {});

      if (oldClient) {
        // Cierre graceful (sin force) para no abortar operaciones en vuelo
        setTimeout(() => { try { oldClient.close(false); } catch(_){} }, 10000);
      }

      console.log('[MONGO] Reconexión exitosa (nuevo cliente creado).');
      return true;
    } catch(e) {
      // No dejar sockets abiertos del cliente que falló
      if (newClient) { try { await newClient.close(true); } catch(_){} }
      console.warn('[MONGO] Reconexión falló:', e.message);
      return false;
    } finally {
      reconnectInProgress = false;
    }
  }
};
