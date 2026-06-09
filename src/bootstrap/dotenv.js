// Единственная задача этого модуля — как можно раньше загрузить файл .env в process.env.
// Он обязан отработать ДО первого импорта пакета config (node-config), иначе значения из .env
// не попадут в process.env к моменту, когда node-config применяет custom-environment-variables.yaml.
// Поэтому src/config.js импортирует этот модуль самой первой строкой.
import * as dotenv from 'dotenv';

export const dotEnvResult = dotenv.config({ quiet: true });
