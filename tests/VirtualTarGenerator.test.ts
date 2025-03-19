import fs from 'fs';
import path from 'path';
import os from 'os';
import { test } from '@fast-check/jest';
import * as tar from 'tar';
import { VirtualTarGenerator } from '@';

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

  test('should write data to file', async () => {
    // Set the file names and their data
    const fileName1 = 'file1.txt';
    const fileName2 = 'file2.txt';
    const fileName3 = 'file3.txt';
    const fileData = 'testing';
    const fileMode = 0o777;

    const vtar = new VirtualTarGenerator();

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

    const vtar = new VirtualTarGenerator();

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
