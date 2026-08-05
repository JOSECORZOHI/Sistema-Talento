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
  serverSelectionTimeoutMS: 5000,
  heartbeatFrequencyMS: 8000,
  socketTimeoutMS: 15000,
  connectTimeoutMS: 5000,
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
  const hasParams = uri.includes('?');
  const baseParams = 'retryWrites=true&w=majority';
  if (!hasParams) return uri + '?' + baseParams;
  const query = uri.split('?')[1] || '';
  const params = new Set(query.split('&').filter(Boolean).map(p => p.split('=')[0]));
  const missing = baseParams.split('&').filter(p => !params.has(p.split('=')[0]));
  return missing.length ? uri + '&' + missing.join('&') : uri;
}

let client = null;
let db = null;
let initPromise = null;
let bucket = null;

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

async function ensureIndexes() {
  try {
    await db.collection(COLLECTIONS.loginAttempts).createIndex({ identifier: 1, timestamp: -1 });
    await db.collection(COLLECTIONS.loginAttempts).createIndex({ timestamp: 1 }, { expireAfterSeconds: 900 });
    await db.collection(COLLECTIONS.passwordResetTokens).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await db.collection(COLLECTIONS.documents).createIndex({ employeeId: 1 });
    await db.collection(COLLECTIONS.documents).createIndex({ filename: 1 });
    await db.collection(COLLECTIONS.users).createIndex({ email: 1 }, { unique: true });
    await db.collection(COLLECTIONS.auditLogs).createIndex({ timestamp: -1 });
    await db.collection(COLLECTIONS.emailsInbox).createIndex({ id: 1 }, { unique: true, sparse: true });
  } catch (e) { console.warn('[MONGO] Error creando índices:', e.message); }
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
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          if (client) { try { await client.close(true); } catch (_) {} client = null; }

          client = new MongoClient(uri, MONGO_OPTIONS);

          client.on('error', (err) => {
            console.warn('[MONGO] Error en el pool de conexiones:', err.message);
          });

          await client.connect();
          await client.db('admin').command({ ping: 1 });
          break;
        } catch (err) {
          lastError = err;
          console.warn(`Intento ${attempt}/${MAX_RETRIES} de conexión a MongoDB falló: ${err.message}`);
          if (client) { try { await client.close(true); } catch (_) {} client = null; }
          if (attempt < MAX_RETRIES) {
            const delay = 1000 + Math.random() * 1500;
            await new Promise(r => setTimeout(r, delay));
          }
        }
      }
      if (!client) {
        throw lastError;
      }

      const dbName = process.env.DATABASE_NAME || 'talento_humano';
      db = client.db(dbName);
      bucket = new GridFSBucket(db, { bucketName: BUCKET_NAME });

      // Sembrar desde database.json local si las colecciones están vacías
      // Crear índices ANTES del seed para que users.email (único) evite duplicados (race en arranque)
      await ensureIndexes();

      const usersCount = await db.collection(COLLECTIONS.users).countDocuments();
      if (usersCount === 0) {
        const seed = readLocalSeed();
        console.log('Poblando MongoDB desde database.json de referencia...');

        // Usuarios: garantiza al menos un admin aunque no exista database.json
        let seedUsers = (seed && Array.isArray(seed.users) && seed.users.length > 0) ? seed.users : [{
          email: 'admin@valledupar-cesar.gov.co',
          name: 'Administrador Talento Humano',
          role: 'admin',
          department: 'Talento Humano',
          active: true
        }];

        // Sin contraseña definida => contraseña temporal aleatoria de un solo uso (nunca una conocida)
        const tempPasswords = new Map();
        for (const u of seedUsers) {
          if (!u.password) {
            const temp = generateTempPassword();
            u.password = await bcrypt.hash(temp, 12);
            tempPasswords.set(u.email, temp);
          }
        }

        seedUsers = enforceSingleAdmin(seedUsers);
        if (seedUsers.length > 0) {
          await db.collection(COLLECTIONS.users).insertMany(seedUsers);
        }

        if (tempPasswords.size > 0) {
          for (const [email, temp] of tempPasswords) {
            console.warn(`[SEGU] Usuario sembrado sin contraseña definida (${email}). Contraseña temporal de un solo uso: ${temp} (cámbiela en el primer inicio).`);
          }
          try {
            await db.collection(COLLECTIONS.securityLogs).insertOne({
              id: 'sec_seed_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'),
              timestamp: new Date().toISOString(),
              event: 'SEED_INIT',
              details: `Base de datos inicializada. Se generaron contraseñas temporales de un solo uso para ${tempPasswords.size} usuario(s) sin contraseña definida.`,
              ip: 'local',
              email: 'sistema',
              severity: 'warning'
            });
          } catch (_) {}
        }

        // Empleados
        if (seed && Array.isArray(seed.employees) && seed.employees.length > 0) {
          await db.collection(COLLECTIONS.employees).insertMany(seed.employees);
        }

        // Tipos de documento
        if (seed && Array.isArray(seed.documentTypes) && seed.documentTypes.length > 0) {
          await db.collection(COLLECTIONS.documentTypes).insertMany(seed.documentTypes);
        }

        // Categorías
        if (seed && Array.isArray(seed.categories) && seed.categories.length > 0) {
          await db.collection(COLLECTIONS.categories).insertMany(seed.categories);
        }

        // Documentos
        if (seed && Array.isArray(seed.documents) && seed.documents.length > 0) {
          await db.collection(COLLECTIONS.documents).insertMany(seed.documents);
        }

        // Registros de auditoría
        if (seed && Array.isArray(seed.auditLogs) && seed.auditLogs.length > 0) {
          await db.collection(COLLECTIONS.auditLogs).insertMany(seed.auditLogs);
        }

        // Bandeja de correos
        if (seed && Array.isArray(seed.emailsInbox) && seed.emailsInbox.length > 0) {
          await db.collection(COLLECTIONS.emailsInbox).insertMany(seed.emailsInbox);
        }

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

// Verificar salud de la conexión
async function isHealthy() {
  try {
    if (!client || !db) return false;
    await client.db('admin').command({ ping: 1 });
    return true;
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
    us.end(buffer);
    us.on('finish', () => resolve(us.id));
    us.on('error', reject);
  });
}

function storeFileStream(filename, stream, metadata = {}) {
  return new Promise((resolve, reject) => {
    const us = getBucket().openUploadStream(filename, { metadata });
    stream.pipe(us);
    us.on('finish', () => resolve(us.id));
    us.on('error', reject);
    stream.on('error', reject);
  });
}

async function readFileStream(filename) {
  const bucket = getBucket();
  const cursor = bucket.find({ filename }).sort({ uploadDate: -1 }).limit(1);
  const file = await cursor.next();
  if (!file) return null;
  return { stream: bucket.openDownloadStream(file._id), file };
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
  const cursor = bucket.find({ filename }).limit(1);
  const file = await cursor.next();
  if (!file) throw new Error(`Archivo '${filename}' no encontrado en GridFS`);
  const collection = db.collection(`${BUCKET_NAME}.files`);
  await collection.updateOne({ _id: file._id }, { $set: { 'metadata.registered': true } });
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
    try {
      const uri = process.env.DATABASE_URL;
      if (!uri) return false;
      const fullUri = buildUri(uri);

      const newClient = new MongoClient(fullUri, MONGO_OPTIONS);
      newClient.on('error', err => console.warn('[MONGO] Error de pool en reconexión:', err.message || err));

      await newClient.connect();
      await newClient.db('admin').command({ ping: 1 });
      const newDb = newClient.db(process.env.DATABASE_NAME || 'talento_humano');

      const oldClient = client;
      client = newClient;
      db = newDb;
      bucket = new GridFSBucket(db, { bucketName: 'documentos' });
      initPromise = null;

      await runMigrations().catch(() => {});
      await ensureIndexes().catch(() => {});

      if (oldClient) {
        setTimeout(() => { try { oldClient.close(true); } catch(_){} }, 10000);
      }

      console.log('[MONGO] Reconexión exitosa (nuevo cliente creado).');
      return true;
    } catch(e) {
      console.warn('[MONGO] Reconexión falló:', e.message);
      return false;
    }
  }
};
