import * as dotenv from 'dotenv';
dotenv.config();

import readlineSync from 'readline-sync';
import { askQuestion } from './lib/rag.js';

const history = [];

async function main() {
  while (true) {
    const userProblem = readlineSync.question('Ask me anything--> ');
    if (!userProblem || userProblem.toLowerCase() === 'exit') {
      break;
    }

    try {
      const result = await askQuestion({ question: userProblem, history });
      history.splice(0, history.length, ...result.history);

      console.log('\n');
      console.log(result.answer);
    } catch (error) {
      const status = error?.status ?? error?.response?.status ?? error?.cause?.status;
      if (status === 429) {
        console.log(
          'OpenAI quota/rate limit exceeded. Wait for quota reset or use a billed API key/project, then retry.'
        );
      } else {
        console.error('Error:', error?.message || error);
      }
    }
  }
}

main();
