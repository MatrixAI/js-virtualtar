import type { VirtualFile, VirtualDirectory } from './types';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { test } from '@fast-check/jest';
import * as tar from 'tar';
import VirtualTar from '@/VirtualTar';
import { VirtualTarState } from '@/types';
import * as utils from './utils';

describe('generator', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'js-virtualtar-test-'),
    );
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  test('should set state to generation', async () => {
    const tar = new VirtualTar({ mode: 'generate' });
    // @ts-ignore accessing protected member for state analysis
    expect(tar.state).toEqual(VirtualTarState.GENERATOR);
  });

  test('should write data to file', async () => {
    // Set the file names and their data
    const fileName1 = 'file1.txt';
    const fileName2 = 'file2.txt';
    const fileName3 = 'file3.txt';
    const fileData = 'testing';
    const fileMode = 0o777;

    const vtar = new VirtualTar({ mode: 'generate' });

    // Write file to archive
    vtar.addFile(
      fileName1,
      { size: fileData.length, mode: fileMode },
      fileData,
    );
    vtar.addFile(
      fileName2,
      { size: fileData.length, mode: fileMode },
      Buffer.from(fileData),
    );
    vtar.addFile(
      fileName3,
      { size: fileData.length, mode: fileMode },
      async function* () {
        const halfway = Math.floor(fileData.length / 2);
        const prefix = fileData.slice(0, halfway);
        const suffix = fileData.slice(halfway);

        // Mixing string and Uint8Array data
        yield Buffer.from(prefix);
        yield suffix;
      },
    );
    vtar.finalize();

    const archivePath = path.join(tempDir, 'archive.tar');
    const fd = await fs.promises.open(archivePath, 'w');
    for await (const chunk of vtar.yieldChunks()) {
      await fd.write(chunk);
    }
    await fd.close();

    await tar.extract({
      file: archivePath,
      cwd: tempDir,
    });

    // Check if each file has been written correctly
    const extractedData1 = await fs.promises.readFile(
      path.join(tempDir, fileName1),
    );
    const extractedData2 = await fs.promises.readFile(
      path.join(tempDir, fileName2),
    );
    const extractedData3 = await fs.promises.readFile(
      path.join(tempDir, fileName3),
    );
    expect(extractedData1.toString()).toEqual(fileData);
    expect(extractedData2.toString()).toEqual(fileData);
    expect(extractedData3.toString()).toEqual(fileData);
  });

  test('should write a directory to the archive', async () => {
    // Set the file names and their data
    const dirName = 'dir';
    const dirMode = 0o777;

    const vtar = new VirtualTar({ mode: 'generate' });

    // Write directory to archive
    vtar.addDirectory(dirName, { mode: dirMode });
    vtar.finalize();

    const archivePath = path.join(tempDir, 'archive.tar');
    const fd = await fs.promises.open(archivePath, 'w');
    for await (const chunk of vtar.yieldChunks()) {
      await fd.write(chunk);
    }
    await fd.close();

    await tar.extract({
      file: archivePath,
      cwd: tempDir,
    });
    await fs.promises.rm(archivePath);

    // Check if the directory has been written correctly
    const directories = await fs.promises.readdir(path.join(tempDir));
    expect(directories).toEqual([dirName]);
  });
});

describe('parser', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'js-virtualtar-test-'),
    );
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  test('should set state to parsing', async () => {
    const tar = new VirtualTar({ mode: 'parse' });
    // @ts-ignore accessing protected member for state analysis
    expect(tar.state).toEqual(VirtualTarState.PARSER);
  });

  test('should read files and directories', async () => {
    // Set the file names and their data
    const dirName = 'dir';
    const fileName1 = 'file.txt';
    const fileName2 = 'dir/file.txt';
    const fileData = 'testing';

    await fs.promises.mkdir(path.join(tempDir, dirName));
    await fs.promises.writeFile(path.join(tempDir, fileName1), fileData);
    await fs.promises.writeFile(path.join(tempDir, fileName2), fileData);

    const archive = tar.create(
      {
        cwd: tempDir,
        preservePaths: true,
      },
      [fileName1, dirName, fileName2],
    );

    const entries: Record<string, string | undefined> = {};

    // Read files and directories and add it to the entries record
    const vtar = new VirtualTar({
      mode: 'parse',
      onFile: async (header, data) => {
        const content: Array<Uint8Array> = [];
        for await (const chunk of data()) {
          content.push(chunk);
        }
        const fileContent = Buffer.concat(content).toString();
        entries[header.path] = fileContent;
      },
      onDirectory: async (header) => {
        entries[header.path] = undefined;
      },
    });

    // Enqueue each generated chunk from the archive
    for await (const chunk of archive) {
      vtar.write(chunk);
    }

    // Make sure all the callbacks settle
    await vtar.settled();

    expect(entries[dirName]).toBeUndefined();
    expect(entries[fileName1]).toEqual(fileData);
    expect(entries[fileName2]).toEqual(fileData);
  });
});

describe('integration tests', () => {
  test.prop([utils.fileTreeArb()])(
    'archiving and unarchiving a file tree',
    async (fileTree) => {
      const generator = new VirtualTar({ mode: 'generate' });

      for (const entry of fileTree) {
        if (entry.type === 'file') {
          generator.addFile(entry.path, entry.stat, entry.content);
        } else {
          generator.addDirectory(entry.path, entry.stat);
        }
      }
      generator.finalize();

      const archive = generator.yieldChunks();
      const entries: Array<VirtualFile | VirtualDirectory> = [];

      const parser = new VirtualTar({
        mode: 'parse',
        onFile: async (header, data) => {
          const content: Array<Uint8Array> = [];
          for await (const chunk of data()) {
            content.push(chunk);
          }
          const fileContent = Buffer.concat(content).toString();
          entries.push({
            type: 'file',
            path: header.path,
            stat: header.stat,
            content: fileContent,
          });
        },
        onDirectory: async (header) => {
          entries.push({
            type: 'directory',
            path: header.path,
            stat: header.stat,
          });
        },
      });

      for await (const chunk of archive) {
        parser.write(chunk);
      }

      await parser.settled();

      expect(utils.deepSort(entries)).toContainAllValues(
        utils.deepSort(fileTree),
      );
    },
  );
});
