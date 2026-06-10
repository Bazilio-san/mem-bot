/*
Output of startup diagnostics to the console.
*/
import { yellow } from 'af-color';
import { configInfo, databasesInfo, infoBlock, nodeConfigEnvInfo } from 'af-tools-ts';
import chalk from 'chalk';

import { config as cfg } from '../config.js';
import { dotEnvResult } from './dotenv.js';

const logger = {
  info: (...args) => console.log(chalk.cyan(...args)),
  warn: (...args) => console.warn(chalk.yellow(...args)),
};

const dbConnection = (id) => {
  const db = cfg?.db?.postgres?.dbs?.[id] || {};
  const mainDb = cfg?.db?.postgres?.dbs?.main || {};
  const host = db.host || db.server || mainDb.host || '<inherit>';
  const port = db.port || mainDb.port || '5432';
  const user = db.user || mainDb.user || '<no user>';
  const database = db.database || `<${id} not set>`;
  const label = db.label || `${id} DB`;
  return {
    host,
    port,
    user,
    database,
    label,
  };
};

const dbInfoLine = (id) => {
  const d = dbConnection(id);
  const dbName = d.database || '<not set>';
  const location = `${d.host}${d.port ? `:${d.port}` : ''}`;
  const lineValue = `${dbName} @ ${location} as ${d.user}`;
  return [`${id.toUpperCase()} DB`, `${d.label} (${lineValue})`];
};

export const startupInfo = async (args = {}) => {
  const { customStartupInfo = [] } = args;

  configInfo({ dotEnvResult, cfg: JSON.parse(JSON.stringify(cfg)) });

  const hasMainDb = Boolean(cfg?.db?.postgres?.dbs?.main?.host);
  const dbInfo = hasMainDb ? [...databasesInfo(cfg, ['main'])] : [['Main DB', 'disabled']];
  const logsDbLine = dbInfoLine('logs');

  const info = [
    `${yellow}${cfg.productName || cfg.name || 'MEM BOT'} (v ${cfg.version || 'unknown'})`,
    nodeConfigEnvInfo(),
    ['NODE VERSION', process.version],
    ['NODE_ENV', process.env.NODE_ENV],
    ['Admin', `${cfg.admin?.host || 'localhost'}:${cfg.admin?.port || 9019}`],
    ...dbInfo,
    logsDbLine,
    ['Admin auth', cfg.admin?.auth?.enabled ? 'enabled' : 'disabled'],
    ...(customStartupInfo || []),
  ].filter(Boolean);

  const infoStr = infoBlock({ info });
  logger.info(`\n${infoStr}`);
};
