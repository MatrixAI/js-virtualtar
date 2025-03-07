import type { VirtualFile, VirtualDirectory } from './types';
import fs from 'fs';
import os from 'os';
import path from 'path';
import fc from 'fast-check';
import { test } from '@fast-check/jest';
import { EntryType, GeneratorState } from '@/types';
import Generator from '@/Generator';
import * as tar from 'tar';
import * as tarConstants from '@/constants';
import * as tarErrors from '@/errors';
import * as tarUtils from '@/utils';
import * as utils from './utils';

describe('generating archive', () => {
  test.prop([utils.fileArb()])(
    'should generate a valid file header',
    (file) => {
      // Generate and split the header
      const generator = new Generator();
      const header = generator.generateFile(file.path, file.stat);
      const { name, type, mode, uid, gid, size, mtime, format, version } =
        utils.splitHeaderData(header);

      // @ts-ignore: accessing protected member for state analysis
      const state = generator.state;
      if (file.stat.size === 0) expect(state).toEqual(GeneratorState.HEADER);
      else expect(state).toEqual(GeneratorState.DATA);

      // Compare the values to the expected ones
      expect(name).toEqual(file.path);
      expect(type).toEqual(EntryType.FILE);
      expect(mode).toEqual(file.stat.mode);
      expect(uid).toEqual(file.stat.uid);
      expect(gid).toEqual(file.stat.gid);
      expect(size).toEqual(file.stat.size);
      expect(mtime).toEqual(tarUtils.dateToUnixTime(file.stat.mtime!));
      expect(format).toEqual('ustar');
      expect(version).toEqual('00');
    },
  );

  test.prop([utils.dirArb(0)])(
    'should generate a valid directory header',
    (file) => {
      // Generate and split the header
      const generator = new Generator();
      const header = generator.generateDirectory(file.path, file.stat);
      const { name, type, mode, uid, gid, size, mtime, format, version } =
        utils.splitHeaderData(header);

      // @ts-ignore: accessing protected member for state analysis
      const state = generator.state;
      if (file.stat.size === 0) expect(state).toEqual(GeneratorState.HEADER);

      // Compare the values to the expected ones
      expect(name).toEqual(file.path);
      expect(type).toEqual(EntryType.DIRECTORY);
      expect(mode).toEqual(file.stat.mode);
      expect(uid).toEqual(file.stat.uid);
      expect(gid).toEqual(file.stat.gid);
      expect(size).toEqual(0);
      expect(mtime).toEqual(tarUtils.dateToUnixTime(file.stat.mtime!));
      expect(format).toEqual('ustar');
      expect(version).toEqual('00');
    },
  );

  test('should generate a valid null chunk', () => {
    const generator = new Generator();
    const nullChunk = generator.generateEnd();
    expect(nullChunk.reduce((sum, byte) => (sum += byte))).toBe(0);

    // @ts-ignore: accessing protected member for state analysis
    const state = generator.state;
    expect(state).toEqual(GeneratorState.NULL);
  });
});

describe('generator state robustness', () => {
  test.prop([utils.fileContentArb(0)], { numRuns: 1 })(
    'should fail writing data when header is expected',
    (data) => {
      const generator = new Generator();
      const encoder = new TextEncoder();
      expect(() => generator.generateData(encoder.encode(data))).toThrowError(
        tarErrors.ErrorVirtualTarGeneratorInvalidState,
      );
    },
  );

  test.prop([utils.fileArb(), utils.fileArb()], { numRuns: 1 })(
    'should fail writing new header if previous file header has not sent any data',
    (file1, file2) => {
      fc.pre(file1.stat.size !== 0);
      const generator = new Generator();

      // Writing first file
      generator.generateFile(file1.path, file1.stat);
      // @ts-ignore: accessing protected member for state analysis
      const state1 = generator.state;
      expect(state1).toEqual(GeneratorState.DATA);

      // Writing second file
      expect(() => generator.generateFile(file2.path, file2.stat)).toThrowError(
        tarErrors.ErrorVirtualTarGeneratorInvalidState,
      );
    },
  );

  test.prop(
    [fc.oneof(utils.fileContentArb(), utils.fileArb(), utils.dirArb(0))],
    { numRuns: 10 },
  )('should fail writing data when attempting to end archive', (data) => {
    const generator = new Generator();

    // Parse the type of incoming data and smartly switch between different
    // methods of writing to the generator.
    const writeData = () => {
      if (typeof data === 'string') {
        const encoder = new TextEncoder();
        generator.generateData(encoder.encode(data));
      } else if (data.type === 'file') {
        generator.generateFile(data.path, data.stat);
      } else {
        generator.generateDirectory(data.path, data.stat);
      }
    };

    generator.generateEnd();
    expect(writeData).toThrowError(
      tarErrors.ErrorVirtualTarGeneratorInvalidState,
    );
  });

  test.prop(
    [fc.oneof(utils.fileContentArb(), utils.fileArb(), utils.dirArb(0))],
    { numRuns: 10 },
  )('should fail writing data after ending archive', (data) => {
    const generator = new Generator();

    // Parse the type of incoming data and smartly switch between different
    // methods of writing to the generator.
    const writeData = () => {
      if (typeof data === 'string') {
        const encoder = new TextEncoder();
        generator.generateData(encoder.encode(data));
      } else if (data.type === 'file') {
        generator.generateFile(data.path, data.stat);
      } else {
        generator.generateDirectory(data.path, data.stat);
      }
    };

    generator.generateEnd();
    generator.generateEnd();
    expect(writeData).toThrowError(
      tarErrors.ErrorVirtualTarGeneratorInvalidState,
    );
  });
});

describe('testing against tar', () => {
  test.skip.prop([utils.virtualFsArb])('should match output of tar', async (vfs) => {
    // Create a temp directory to use for node-tar
    const tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'js-virtualtar-test-'),
    );

    try {
      // Create the archive using the Generator
      const generator = new Generator();
      const blocks: Array<Uint8Array> = [];

      const trimmedVfs = structuredClone(vfs);
      const trimStat = (entry: VirtualFile | VirtualDirectory) => {
        entry.stat = { size: entry.stat.size, mode: entry.stat.mode };
        if (entry.type === 'directory') {
          for (const child of entry.children) {
            trimStat(child);
          }
        }
      };
      for (const entry of trimmedVfs) trimStat(entry);

      const generateEntry = (entry: VirtualFile | VirtualDirectory) => {
        // Due to operating system restrictions, node-tar cannot properly
        // reproduce all the metadata at the time of extracting files. The
        // mtime defaults to extraction time, the uid and gid is fixed to the
        // user who the program is running under. As fast-check is used to
        // generate this data, this will always differ than the observed stat,
        // so these fields will be ignored for this test.
        entry.stat = {
          mode: entry.stat.mode,
          size: entry.stat.size,
        };

        if (entry.path.length > tarConstants.STANDARD_PATH_SIZE) {
          // Push the extended metadata header
          const data = tarUtils.encodeExtendedHeader({ path: entry.path });
          blocks.push(generator.generateExtended(data.byteLength));

          // Push the content block
          for (
            let offset = 0;
            offset < data.byteLength;
            offset += tarConstants.BLOCK_SIZE
          ) {
            blocks.push(
              generator.generateData(
                data.subarray(offset, offset + tarConstants.BLOCK_SIZE),
              ),
            );
          }
        }

        const filePath =
          entry.path.length <= tarConstants.STANDARD_PATH_SIZE
            ? entry.path
            : '';

        switch (entry.type) {
          case 'file': {
            // Generate the header
            entry = entry as VirtualFile;
            blocks.push(generator.generateFile(filePath, entry.stat));

            // Generate the data
            const encoder = new TextEncoder();
            let content = entry.content;
            while (content.length > 0) {
              const dataChunk = content.slice(0, tarConstants.BLOCK_SIZE);
              blocks.push(generator.generateData(encoder.encode(dataChunk)));
              content = content.slice(tarConstants.BLOCK_SIZE);
            }
            break;
          }

          case 'directory': {
            // Generate the header
            entry = entry as VirtualDirectory;
            blocks.push(generator.generateDirectory(filePath, entry.stat));

            // Perform the same operation on all children
            for (const file of entry.children) {
              generateEntry(file);
            }
            break;
          }

          default:
            throw new Error('Invalid type');
        }
      };

      for (const entry of vfs) generateEntry(entry);
      blocks.push(generator.generateEnd());
      blocks.push(generator.generateEnd());

      // Write the archive to fs
      const archivePath = path.join(tempDir, 'archive.tar');
      const tarFile = await fs.promises.open(archivePath, 'w+');
      for (const block of blocks) await tarFile.write(block);
      await tarFile.close();

      const vfsPath = path.join(tempDir, 'vfs');
      await fs.promises.mkdir(vfsPath, { recursive: true });
      await tar.extract({
        file: archivePath,
        cwd: vfsPath,
        preservePaths: true,
      });

      // Reconstruct the vfs and compare the contents to actual vfs
      const traverse = async (currentPath: string) => {
        const entries = await fs.promises.readdir(currentPath, {
          withFileTypes: true,
        });
        const vfsEntries: Array<VirtualFile | VirtualDirectory> = [];

        for (const entry of entries) {
          const fullPath = path.join(currentPath, entry.name);
          const relativePath = path.relative(vfsPath, fullPath);
          const stats = await fs.promises.stat(fullPath);

          if (entry.isDirectory()) {
            // Sometimes, the size of a directory on disk might not be 0 bytes
            // due to the storage of additional metadata. This is different from
            // the way tar stores directories, so the size is being manually set.
            const entry: VirtualDirectory = {
              type: 'directory',
              path: relativePath + '/',
              children: await traverse(fullPath),
              stat: { size: 0, mode: stats.mode },
            };
            vfsEntries.push(entry);
          } else {
            const content = await fs.promises.readFile(fullPath);
            const entry: VirtualFile = {
              type: 'file',
              path: relativePath,
              content: content.toString(),
              stat: { size: stats.size, mode: stats.mode },
            };
            vfsEntries.push(entry);
          }
        }

        return vfsEntries;
      };

      const reconstructedVfs = await traverse(vfsPath);
      expect(utils.deepSort(reconstructedVfs)).toEqual(utils.deepSort(vfs));
    } finally {
      await fs.promises.rm(tempDir, { force: true, recursive: true });
    }
  });
});
