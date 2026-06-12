import { getBotBuildInfo } from '../../build-metadata.js';

export const botBuildInfoTool = {
  name: 'bot_build_info',
  title: 'Читаю версию и git-метаданные сборки...',
  definition: {
    type: 'function',
    function: {
      name: 'bot_build_info',
      description: 'Return bot version, current commit hash and commit time.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    },
  },
  async handler() {
    return getBotBuildInfo();
  },
};
