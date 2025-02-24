import type { FileStat } from '@/types';
import fs from 'fs';
import path from 'path';
import { createHeader, generateEndMarker } from '@/Generator';
import Parser from '@/Parser';
import { EntryType } from '@/types';

// TODO: actually write tests
describe('local test', () => {
  test('gen', async () => {
    if (process.env['CI'] != null) {
      // Skip this test if on CI
      expect(true).toEqual(true);
    } else {
      // Otherwise, run the test which creates a test archive

      const walkDir = async (walkPath: string, tokens: Array<Uint8Array>) => {
        const dirContent = await fs.promises.readdir(walkPath);

        for (const dirPath of dirContent) {
          const stat = await fs.promises.stat(path.join(walkPath, dirPath));
          const tarStat: FileStat = {
            mtime: stat.mtime,
            mode: stat.mode,
            gid: stat.gid,
            uid: stat.uid,
          };

          if (stat.isDirectory()) {
            tokens.push(createHeader(dirPath, tarStat, EntryType.DIRECTORY));
            await walkDir(dirPath, tokens);
          } else {
            const tarStat: FileStat = {
              mtime: stat.mtime,
              mode: stat.mode,
              gid: stat.gid,
              uid: stat.uid,
              size: stat.size,
            };
            tokens.push(createHeader(dirPath, tarStat, EntryType.FILE));
            const file = await fs.promises.open(
              path.join(walkPath, dirPath),
              'r',
            );
            const buffer = Buffer.alloc(512, 0);
            while (true) {
              const { bytesRead } = await file.read(buffer, 0, 512, null);
              if (bytesRead < 512) {
                buffer.fill('\0', bytesRead);
                tokens.push(buffer);
                break;
              }
              tokens.push(Buffer.from(buffer));
            }
            await file.close();
          }
        }

        tokens.push(...generateEndMarker());
      };

      const writeArchive = async (inPath: string, outPath: string) => {
        const tokens: Array<Buffer> = [];
        await walkDir(inPath, tokens);

        const file = await fs.promises.open(outPath, 'w+');
        for (const block of tokens) {
          await file.write(block);
        }
        await file.close();
      };

      await expect(
        writeArchive(
          '/home/aryanj/Downloads/Arifureta Shokugyou Saikyou/',
          '/home/aryanj/Downloads/dir/archive.tar',
        ),
      ).toResolve();
    }
  }, 60000);
  test('parsing', async () => {
    if (process.env['CI'] != null) expect(true).toBeTruthy();
    const file = '/home/aryanj/Downloads/dir/archive.tar';

    const fileHandle = await fs.promises.open(file, 'r');
    const buffer = new Uint8Array(512);
    const parser = new Parser();
    let writeHandle: fs.promises.FileHandle | undefined = undefined;
    const root = '/home/aryanj/Downloads/dir';

    while (true) {
      await fileHandle.read(buffer);
      const output = parser.write(buffer);

      if (output == null) continue;

      if (output.type === 'header') {
        if (writeHandle != null) await writeHandle.close();
        if (output.fileType === 'directory') {
          await fs.promises.mkdir(path.join(root, output.fileName));
        } else {
          writeHandle = await fs.promises.open(
            path.join(root, output.fileName),
            'w+',
          );
        }
      }

      if (output.type === 'data') {
        if (writeHandle == null) throw new Error('never');
        await writeHandle.write(output.data);
      }

      if (output.type === 'end') {
        if (writeHandle != null) await writeHandle.close();
        break;
      }
    }
    await fileHandle.close();
  });
});
