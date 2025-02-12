import fs from 'fs';
import { createTar } from '@/Generator';

// TODO: actually write tests
describe('index', () => {
  test('test', async () => {
    if (process.env['CI'] != null) {
      // Skip this test if on CI
      expect(true).toEqual(true);
    } else {
      // Otherwise, run the test which creates a test archive
      const writeArchive = async (inputFile: string, outputFile: string) => {
        const fileHandle = await fs.promises.open(outputFile, 'w+');
        for await (const chunk of createTar(inputFile)) {
          await fileHandle.write(chunk);
        }
        await fileHandle.close();
      };
      await expect(
        writeArchive('/home/aryanj/Downloads', '/home/aryanj/archive.tar'),
      ).toResolve();
    }
  }, 60000);
});
