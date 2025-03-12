import type { VirtualFile, VirtualDirectory } from '../types';
import type { FileStat } from '@/types';
import fc from 'fast-check';
import * as tarConstants from '@/constants';
import * as tarUtils from '@/utils';

/**
 * Creates an arbitrary to produce valid (and common) unix file modes. Note that
 * this is only used for testing virtual file system and not for any tests which
 * interact with the physical file system.
 */
const modeArb = (type?: 'file' | 'directory'): fc.Arbitrary<number> => {
  switch (type) {
    case 'file':
      return fc.constant(0o100755);
    case 'directory':
      return fc.constant(0o40755);
    case undefined:
      return fc.constant(0o755);
  }
};

const uidgidArb: fc.Arbitrary<number> = fc.integer({ min: 1000, max: 4096 });

const sizeArb = (
  type?: 'file' | 'directory',
  content?: string,
): fc.Arbitrary<number> => {
  if (type === 'file') {
    if (content == null) throw new Error('Files must have content');
    return fc.constant(content.length);
  }
  return fc.constant(0);
};

// Produce valid dates which snap to whole seconds
const mtimeArb: fc.Arbitrary<Date> = fc
  .date({
    min: new Date(0),
    max: new Date(0o77777777777 * 1000),
    noInvalidDate: true,
  })
  .map((date) => new Date(Math.floor(date.getTime() / 1000) * 1000));

/**
 * Due to the large amount of conditions, using a string primitive arbitrary
 * takes unfeasibly long to generate values, especially for larger path lengths.
 * To bypass this, an optimisation has been made in the generation process. An
 * array of valid ASCII numbers are generated and any characters which might be
 * invalid on an operating system are filtered out. Then, any complex operations
 * like filtering out compound words are carried out. At this stage, it is much
 * more efficient than applying all these filters on a primitive string arbitrary.
 *
 * This care is needed to make sure operations involving writing files to disk
 * won't be platform-dependent.
 */
const filenameArb = (
  parent: string = '',
  {
    minLength,
    maxLength,
  }: {
    minLength?: number;
    maxLength?: number;
  } = {
    minLength: 1,
    maxLength: 512,
  },
): fc.Arbitrary<string> => {
  // Most of these characters are disallowed by windows
  const restrictedCharacters = '/\\*?"<>|:';
  const filterRegex = /^(\.|\.\.|con|prn|aux|nul|tty|null|zero|full)$/i;

  const charCodes = fc.array(
    fc
      .integer({ min: 33, max: 126 })
      .filter(
        (char) => !restrictedCharacters.includes(String.fromCharCode(char)),
      ),
    { minLength, maxLength },
  );

  const fileName = charCodes.map((chars) => String.fromCharCode(...chars));
  const filteredFileName = fileName.filter((name) => !filterRegex.test(name));

  // If there is a parent path, then properly nest the generated file name
  // relative to the parent path.
  if (parent !== '') {
    return filteredFileName
      .map(
        (name) =>
          `${
            !parent.endsWith('/') && parent !== '' ? parent + '/' : parent
          }${name}`,
      )
      .noShrink();
  }
  return filteredFileName.noShrink();
};

const fileContentArb = (maxLength: number = 4096): fc.Arbitrary<string> =>
  fc.string({ minLength: 0, maxLength, unit: 'binary-ascii' }).noShrink();

const statDataArb = (
  type: 'file' | 'directory',
  content: string = '',
): fc.Arbitrary<FileStat> =>
  fc
    .record({
      mode: modeArb(type),
      uid: uidgidArb,
      gid: uidgidArb,
      size: sizeArb(type, content),
      mtime: mtimeArb,
    })
    .noShrink();

const fileArb = (
  parentPath: string = '',
  dataLength: number = 4096,
  {
    minFilePathSize,
    maxFilePathSize,
  }: {
    minFilePathSize?: number;
    maxFilePathSize?: number;
  } = {},
): fc.Arbitrary<VirtualFile> => {
  // Generate file-specific records
  const fileData = fc.record({
    type: fc.constant<'file'>('file'),
    path: filenameArb(parentPath, {
      minLength: minFilePathSize,
      maxLength: maxFilePathSize,
    }),
    content: fileContentArb(dataLength),
  });

  // Generate the stat based on the file data
  const fileWithStat = fileData.chain((file) =>
    statDataArb('file', file.content).map((stat) => ({
      ...file,
      stat,
    })),
  );

  return fileWithStat.noShrink();
};

const dirArb = (
  depth: number,
  parentPath: string = '',
  {
    minFilePathSize,
    maxFilePathSize,
  }: {
    minFilePathSize?: number;
    maxFilePathSize?: number;
  } = {},
): fc.Arbitrary<VirtualDirectory> => {
  // Generate directory-specific records
  const dirData = fc.record({
    type: fc.constant<'directory'>('directory'),
    path: filenameArb(parentPath, {
      minLength: minFilePathSize,
      maxLength: maxFilePathSize,
    }).map(
      (name) =>
        `${
          !parentPath.endsWith('/') && parentPath !== ''
            ? parentPath + '/'
            : parentPath
        }${name}/`,
    ),
  });

  // Add either subdirectories or files as children of the directory
  const populatedDir = dirData.chain((dir) => {
    // By default, there is a 1 in 4 chance of a subdirectory being created under
    // this directory. However, if we have reached the maximum depth of recursion,
    // then the directory weight drops to zero, ensuring all entries will be a
    // file.
    const dirWeight = depth > 0 ? 1 : 0;

    const fileOrDir = fc.oneof(
      {
        weight: 3,
        arbitrary: fileArb(dir.path, undefined, {
          minFilePathSize,
          maxFilePathSize,
        }),
      },
      {
        weight: dirWeight,
        arbitrary: dirArb(depth - 1, dir.path, {
          minFilePathSize,
          maxFilePathSize,
        }),
      },
    );

    const children = fc.array(fileOrDir, { minLength: 0, maxLength: 4 });
    return children.map((children) => ({ ...dir, children }));
  });

  const dirWithStat = populatedDir.chain((dir) =>
    statDataArb('directory').map((stat) => ({ ...dir, stat })),
  );

  return dirWithStat.noShrink();
};

/**
 * Uses arbitraries generating files and directories to create a virtual file
 * system as a JSON object.
 */
const fileTreeArb: fc.Arbitrary<Array<VirtualFile | VirtualDirectory>> = fc
  .array(fc.oneof(fileArb(), dirArb(5)), {
    minLength: 1,
    maxLength: 10,
  })
  .noShrink();

const tarEntryArb = ({
  minFilePathSize,
  maxFilePathSize,
}: {
  minFilePathSize?: number;
  maxFilePathSize?: number;
} = {}): fc.Arbitrary<{
  headers: Array<Uint8Array>;
  data: VirtualFile | VirtualDirectory;
}> => {
  const data = fc.oneof(
    fileArb(undefined, undefined, { minFilePathSize, maxFilePathSize }),
    dirArb(0, undefined, { minFilePathSize, maxFilePathSize }),
  );

  const headers = data.map((data) => {
    const extendedHeaders: Array<Uint8Array> = [];
    const header = new Uint8Array(tarConstants.BLOCK_SIZE);
    const dataHeaders: Array<Uint8Array> = [];

    // Write the file path
    if (data.path.length > tarConstants.STANDARD_PATH_SIZE) {
      const extendedData = tarUtils.encodeExtendedHeader({ path: data.path });

      // Create the extended header array
      const extendedHeader = new Uint8Array(tarConstants.BLOCK_SIZE);
      tarUtils.writeFileType(extendedHeader, 'extended');
      tarUtils.writeFileSize(extendedHeader, extendedData.byteLength);
      tarUtils.writeUstarMagic(extendedHeader);
      tarUtils.writeChecksum(
        extendedHeader,
        tarUtils.calculateChecksum(extendedHeader),
      );
      extendedHeaders.push(extendedHeader);

      // Push the data array in 512-byte chunks
      let offset = 0;
      while (offset < extendedData.length) {
        const block = new Uint8Array(tarConstants.BLOCK_SIZE);
        block.set(extendedData.slice(offset, offset + tarConstants.BLOCK_SIZE));
        extendedHeaders.push(block);
        offset += tarConstants.BLOCK_SIZE;
      }
    } else {
      tarUtils.writeFilePath(header, data.path);
    }

    // Write the regular header info
    tarUtils.writeFileType(header, data.type);
    tarUtils.writeFileSize(header, data.stat.size);
    tarUtils.writeFileMode(header, data.stat.mode);
    tarUtils.writeFileMtime(header, data.stat.mtime);
    tarUtils.writeOwnerUid(header, data.stat.uid);
    tarUtils.writeOwnerGid(header, data.stat.gid);
    tarUtils.writeUstarMagic(header);
    tarUtils.writeChecksum(header, tarUtils.calculateChecksum(header));

    // If it is a file, then append the data to the data array
    if (data.type === 'file') {
      let content = data.content;
      const encoder = new TextEncoder();
      while (content.length > 0) {
        const block = new Uint8Array(tarConstants.BLOCK_SIZE);
        const chunk = content.substring(0, tarConstants.BLOCK_SIZE);
        block.set(encoder.encode(chunk));
        dataHeaders.push(block);
        content = content.substring(tarConstants.BLOCK_SIZE);
      }
    }

    return { headers: [...extendedHeaders, header, ...dataHeaders], data };
  });
  return headers.noShrink();
};

export {
  modeArb,
  uidgidArb,
  sizeArb,
  mtimeArb,
  filenameArb,
  fileContentArb,
  statDataArb,
  fileArb,
  dirArb,
  fileTreeArb,
  tarEntryArb,
};
