import fs from 'fs';
import path from 'path';
import os from 'os';
import { test } from '@fast-check/jest';
import * as tar from 'tar';
import { VirtualTarParser } from '#index.js';

describe('parser', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'js-virtualtar-test-'),
    );
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  test('should read files and directories', async () => {
    // Set the file names and their data
    const dirName = 'dir/';
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

    const entries: Record<string, string | null> = {};

    // Read files and directories and add it to the entries record
    const vtar = new VirtualTarParser({
      onFile: async (header, data) => {
        const content: Array<Uint8Array> = [];
        for await (const chunk of data()) {
          content.push(chunk);
        }
        const fileContent = Buffer.concat(content).toString();
        entries[header.path] = fileContent;
      },
      onDirectory: async (header) => {
        entries[header.path] = null;
      },
    });

    // Enqueue each generated chunk from the archive
    for await (const chunk of archive) {
      await vtar.write(chunk);
    }

    expect(entries[dirName]).toBeNull();
    expect(entries[fileName1]).toEqual(fileData);
    expect(entries[fileName2]).toEqual(fileData);
  });

  test('should ignore files if callback is not provided', async () => {
    // Set the file names and their data
    const dirName = 'dir/';
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

    const entries: Record<string, string | null> = {};

    // Read files and directories and add it to the entries record
    const vtar = new VirtualTarParser({
      onDirectory: async (header) => {
        entries[header.path] = null;
      },
    });

    // Enqueue each generated chunk from the archive
    for await (const chunk of archive) {
      await vtar.write(chunk);
    }

    expect(entries[dirName]).toBeNull();
    expect(entries[fileName1]).toBeUndefined();
    expect(entries[fileName2]).toBeUndefined();
  });

  test('should ignore directories if callback is not provided', async () => {
    // Set the file names and their data
    const dirName = 'dir/';
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

    const entries: Record<string, string | null> = {};

    // Read files and directories and add it to the entries record
    const vtar = new VirtualTarParser({
      onFile: async (header, data) => {
        const content: Array<Uint8Array> = [];
        for await (const chunk of data()) {
          content.push(chunk);
        }
        const fileContent = Buffer.concat(content).toString();
        entries[header.path] = fileContent;
      },
    });

    // Enqueue each generated chunk from the archive
    for await (const chunk of archive) {
      await vtar.write(chunk);
    }

    expect(entries[dirName]).toBeUndefined();
    expect(entries[fileName1]).toEqual(fileData);
    expect(entries[fileName2]).toEqual(fileData);
  });

  test('should ignore everything if callback is not provided', async () => {
    // Set the file names and their data
    const dirName = 'dir/';
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

    const entries: Record<string, string | null> = {};

    // Read files and directories and add it to the entries record
    const vtar = new VirtualTarParser();

    // Enqueue each generated chunk from the archive
    for await (const chunk of archive) {
      await vtar.write(chunk);
    }

    expect(Object.keys(entries).length).toEqual(0);
  });
});
