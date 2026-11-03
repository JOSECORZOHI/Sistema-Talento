'use strict';

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL] !== undefined ? LOG_LEVELS[process.env.LOG_LEVEL] : LOG_LEVELS.info;

module.exports = {
  debug: (...args) => {
    if (currentLevel <= LOG_LEVELS.debug) console.log(...args);
  },
  info: (...args) => {
    if (currentLevel <= LOG_LEVELS.info) console.log(...args);
  },
  warn: (...args) => {
    if (currentLevel <= LOG_LEVELS.warn) console.warn(...args);
  },
  error: (...args) => {
    if (currentLevel <= LOG_LEVELS.error) console.error(...args);
  }
};
