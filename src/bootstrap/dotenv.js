// The sole job of this module is to load the .env file into process.env as early as possible.
// It must run BEFORE the first import of the config package (node-config), otherwise the values from .env
// will not be in process.env by the time node-config applies custom-environment-variables.yaml.
// That is why src/config.js imports this module on its very first line.
import * as dotenv from 'dotenv';

export const dotEnvResult = dotenv.config({ quiet: true });
