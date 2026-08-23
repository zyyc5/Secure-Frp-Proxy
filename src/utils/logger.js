const fs = require('fs');
const path = require('path');

const formatLogDate = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const createDailyLogger = (logDirectory, prefix) => (message) => {
  const now = new Date();
  const logEntry = `${now.toLocaleString()} - ${message} \n`;
  const logFile = path.join(logDirectory, `${prefix}-${formatLogDate(now)}.log`);
  console.log(logEntry);
  fs.mkdir(logDirectory, { recursive: true }, (directoryError) => {
    if (directoryError) {
      console.error(`Failed to create log directory: ${directoryError.message}`);
      return;
    }
    fs.appendFile(logFile, logEntry, {}, (writeError) => {
      if (writeError) console.error(`Failed to write log file: ${writeError.message}`);
    });
  });
};

module.exports = { createDailyLogger, formatLogDate };
