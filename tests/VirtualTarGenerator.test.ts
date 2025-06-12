import fs from 'fs';
import path from 'path';
import os from 'os';
import { test } from '@fast-check/jest';
import * as tar from 'tar';
import * as constants from '#constants.js';
import { VirtualTarGenerator } from '#index.js';

describe('generator', () => {
  let tempDir: string;

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

  test('should write to archive while reading data in parallel', async () => {
    // Set the file names and their data
    const fileName1 = 'file1.txt';
    const fileName2 = 'file2.txt';
    const dirName = 'dir';
    const fileData = 'testing';

    const vtar = new VirtualTarGenerator();

    // Write file to archive in parallel to writing data to generator
    const p = (async () => {
      vtar.addFile(fileName1, { size: fileData.length, mode: 0o777 }, fileData);
      vtar.addFile(fileName2, { size: fileData.length, mode: 0o777 }, fileData);
      vtar.addDirectory(dirName);
      vtar.finalize();
    })();

    const archivePath = path.join(tempDir, 'archive.tar');
    const fd = await fs.promises.open(archivePath, 'w');
    for await (const chunk of vtar.yieldChunks()) {
      await fd.write(chunk);
    }
    await fd.close();

    // Cleanup promise for adding files to archive
    await p;

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
    const dirStat = await fs.promises.stat(path.join(tempDir, dirName));
    expect(extractedData1.toString()).toEqual(fileData);
    expect(extractedData2.toString()).toEqual(fileData);
    expect(dirStat.isDirectory()).toBeTrue();
  });

  test('should write file containing exactly 512 bytes of data', async () => {
    // Set the file names and their data
    const fileName = 'file.txt';
    const fileData = new Uint8Array(constants.BLOCK_SIZE).fill(1);

    const vtar = new VirtualTarGenerator();

    // Write file to archive in parallel to writing data to generator
    vtar.addFile(fileName, { size: fileData.length, mode: 0o777 }, fileData);
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

    // Check if file has been written correctly
    const extractedData = await fs.promises.readFile(
      path.join(tempDir, fileName),
    );

    // The sums of all values in both the input and output buffers must be the
    // same.
    const fileSum = fileData.reduce((sum, value) => (sum += value));
    const dataSum = extractedData.reduce((sum, value) => (sum += value));
    expect(dataSum).toEqual(fileSum);
  });
});
