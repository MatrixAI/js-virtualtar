import type { FileStat } from '@/types';
import fc from 'fast-check';
import { ExtendedHeaderKeywords, HeaderSize } from '@/types';
import { HeaderOffset } from '@/types';
import { EntryType } from '@/types';
import * as tarUtils from '@/utils';
import * as tarConstants from '@/constants';

type FileType = {
  type: EntryType.FILE;
  path: string;
  stat: FileStat;
  content: string;
};

type DirectoryType = {
  type: EntryType.DIRECTORY;
  path: string;
  stat: FileStat;
  children: Array<FileType | DirectoryType>;
};

type MetadataType = {
  type: EntryType.EXTENDED;
  size: number;
};

function splitHeaderData(data: Uint8Array) {
  return {
    name: tarUtils.parseFilePath(data),
    type: tarUtils.extractString(data, 156, 1),
    mode: tarUtils.extractOctal(data, 100, 8),
    uid: tarUtils.extractOctal(data, 108, 8),
    gid: tarUtils.extractOctal(data, 116, 8),
    size: tarUtils.extractOctal(data, 124, 12),
    mtime: tarUtils.extractOctal(data, 136, 12),
    format: tarUtils.extractString(data, 257, 6),
    version: tarUtils.extractString(data, 263, 2),
  };
}

const filenameArb = (
  { minLength, maxLength } = { minLength: 1, maxLength: 512 },
) =>
  fc
    .string({ minLength, maxLength })
    .filter((name) => !name.includes('/') && name !== '.' && name !== '..')
    .noShrink();

const fileContentArb = (maxLength: number = 4096) =>
  fc.string({ minLength: 0, maxLength }).noShrink();

// Dates are stored in 11 digits of octal number. This can store from 0 to
// 0o77777777777 or 8589934591 seconds. This comes up to 2242-03-16T12:56:31.
const statDataArb = (
  type: EntryType,
  content: string = '',
): fc.Arbitrary<FileStat> =>
  fc
    .record({
      mode: fc.constant(0o777),
      uid: fc.integer({ min: 0, max: 65535 }),
      gid: fc.integer({ min: 0, max: 65535 }),
      size: fc.constant(type === EntryType.FILE ? content.length : 0),
      mtime: fc
        .date({
          min: new Date(0),
          max: new Date(0o77777777777 * 1000),
          noInvalidDate: true,
        })
        .map((date) => new Date(Math.floor(date.getTime() / 1000) * 1000)), // Snap to whole seconds
    })
    .noShrink();

const fileArb = (
  parentPath: string = '',
  dataLength: number = 4096,
): fc.Arbitrary<FileType> =>
  fc
    .record({
      type: fc.constant<EntryType.FILE>(EntryType.FILE),
      path: filenameArb().map((name) => `${parentPath}/${name}`),
      content: fileContentArb(dataLength),
    })
    .chain((file) =>
      statDataArb(EntryType.FILE, file.content).map((stat) => ({
        ...file,
        stat,
      })),
    )
    .noShrink();

const dirArb = (
  depth: number,
  parentPath: string = '',
): fc.Arbitrary<DirectoryType> =>
  fc
    .record({
      type: fc.constant<EntryType.DIRECTORY>(EntryType.DIRECTORY),
      path: filenameArb().map((name) => `${parentPath}/${name}`),
    })
    .chain((dir) =>
      fc
        .array(
          fc.oneof(
            { weight: 3, arbitrary: fileArb(dir.path) },
            {
              weight: depth > 0 ? 1 : 0,
              arbitrary: dirArb(depth - 1, dir.path),
            },
          ),
          {
            minLength: 0,
            maxLength: 4,
          },
        )
        .map((children) => ({ ...dir, children })),
    )
    .chain((dir) =>
      statDataArb(EntryType.DIRECTORY).map((stat) => ({ ...dir, stat })),
    )
    .noShrink();

const virtualFsArb = fc
  .array(fc.oneof(fileArb(), dirArb(5)), {
    minLength: 1,
    maxLength: 10,
  })
  .noShrink();

const tarHeaderArb = (
  { minLength, maxLength } = {
    minLength: 1,
    maxLength: 512,
  },
) =>
  fc
    .record({
      path: filenameArb({ minLength, maxLength }),
      uid: fc.nat(65535),
      gid: fc.nat(65535),
      size: fc.nat(65536),
      typeflag: fc.constantFrom('0', '5'),
    })
    .map(({ path, uid, gid, size, typeflag }) => {
      let headers: Array<Uint8Array> = [];
      headers.push(new Uint8Array(tarConstants.BLOCK_SIZE));
      const type = typeflag as '0' | '5' | 'x';
      const encoder = new TextEncoder();

      if (type === '5') size = 0;

      // If the
      if (path.length > tarConstants.STANDARD_PATH_SIZE) {
        // Set the metadata for the header
        const extendedHeader = new Uint8Array(tarConstants.BLOCK_SIZE);
        const extendedData = tarUtils.encodeExtendedHeader({
          [ExtendedHeaderKeywords.FILE_PATH]: path,
        });

        // Set the size of the content, the type flag, the ustar values, and the
        // checksum.
        extendedHeader.set(
          encoder.encode(
            tarUtils.pad(
              extendedData.byteLength,
              HeaderSize.FILE_SIZE,
              '0',
              '\0',
            ),
          ),
          HeaderOffset.FILE_SIZE,
        );

        extendedHeader.set(
          encoder.encode(tarConstants.USTAR_NAME),
          HeaderOffset.USTAR_NAME,
        );
        extendedHeader.set(
          encoder.encode(tarConstants.USTAR_VERSION),
          HeaderOffset.USTAR_VERSION,
        );
        extendedHeader.set(
          encoder.encode(EntryType.EXTENDED),
          HeaderOffset.TYPE_FLAG,
        );

        const checksum = tarUtils.calculateChecksum(extendedHeader);
        extendedHeader.set(
          encoder.encode(checksum.toString(8).padStart(6, '0') + '\0 '),
          HeaderOffset.CHECKSUM,
        );

        // Split out the data to 512-byte chunks
        const data: Array<Uint8Array> = [];
        let offset = 0;
        while (offset < extendedData.length) {
          const block = new Uint8Array(tarConstants.BLOCK_SIZE);
          block.set(
            extendedData.slice(offset, offset + tarConstants.BLOCK_SIZE),
          );
          data.push(block);
          offset += tarConstants.BLOCK_SIZE;
        }

        headers = [extendedHeader, ...data, ...headers];
      } else {
        if (path.length < HeaderSize.FILE_NAME) {
          headers
            .at(-1)!
            .set(
              encoder.encode(
                tarUtils.splitFileName(path, 0, HeaderSize.FILE_NAME),
              ),
              HeaderOffset.FILE_NAME,
            );
        } else {
          const fileSuffix = tarUtils.splitFileName(
            path,
            0,
            HeaderSize.FILE_NAME,
          );
          const filePrefix = tarUtils.splitFileName(
            path,
            HeaderSize.FILE_NAME,
            HeaderSize.FILE_NAME_PREFIX,
          );
          headers
            .at(-1)!
            .set(encoder.encode(fileSuffix), HeaderOffset.FILE_NAME);
          headers
            .at(-1)!
            .set(encoder.encode(filePrefix), HeaderOffset.FILE_NAME_PREFIX);
        }
      }

      // Fill normal header fields
      headers.at(-1)!.set(encoder.encode('0000777'), HeaderOffset.FILE_MODE);
      headers
        .at(-1)!
        .set(
          encoder.encode(uid.toString(8).padStart(7, '0')),
          HeaderOffset.OWNER_UID,
        );
      headers
        .at(-1)!
        .set(
          encoder.encode(gid.toString(8).padStart(7, '0')),
          HeaderOffset.OWNER_GID,
        );
      headers
        .at(-1)!
        .set(
          encoder.encode(size.toString(8).padStart(11, '0') + '\0'),
          HeaderOffset.FILE_SIZE,
        );
      headers.at(-1)!.set(encoder.encode('        '), HeaderOffset.CHECKSUM);
      headers.at(-1)!.set(encoder.encode(type), HeaderOffset.TYPE_FLAG);
      headers
        .at(-1)!
        .set(encoder.encode(tarConstants.USTAR_NAME), HeaderOffset.USTAR_NAME);
      headers
        .at(-1)!
        .set(
          encoder.encode(tarConstants.USTAR_VERSION),
          HeaderOffset.USTAR_VERSION,
        );

      // Compute and set checksum
      const checksum = headers.at(-1)!.reduce((sum, byte) => sum + byte, 0);
      headers
        .at(-1)!
        .set(
          encoder.encode(checksum.toString(8).padStart(6, '0') + '\0 '),
          HeaderOffset.CHECKSUM,
        );

      return { headers, stat: { type, size, path, uid, gid } };
    })
    .noShrink();

const tarDataArb = tarHeaderArb()
  .chain((header) =>
    fc
      .record({
        header: fc.constant(header),
        data: fc.string({
          minLength: header.stat.size,
          maxLength: header.stat.size,
        }),
      })
      .map(({ header, data }) => {
        const { headers, stat } = header;
        const encoder = new TextEncoder();
        const encodedData = encoder.encode(data);

        // Directories don't have any data, so set their size to zero.
        let dataBlock: Uint8Array;
        if (stat.type === '0') {
          // Make sure the data is aligned to 512-byte chunks
          dataBlock = new Uint8Array(
            Math.ceil(stat.size / tarConstants.BLOCK_SIZE) *
              tarConstants.BLOCK_SIZE,
          );
          dataBlock.set(encodedData);
        } else {
          dataBlock = new Uint8Array(0);
        }

        return {
          headers: headers,
          data: data,
          encodedData: dataBlock,
          type: stat.type,
        };
      }),
  )
  .noShrink();

export type { FileType, DirectoryType, MetadataType };
export {
  splitHeaderData,
  filenameArb,
  fileContentArb,
  statDataArb,
  fileArb,
  dirArb,
  virtualFsArb,
  tarHeaderArb,
  tarDataArb,
};
