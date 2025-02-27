import { FileStat, HeaderOffset } from '@/types';
import fc from 'fast-check';
import { EntryType } from '@/types';
import * as tarUtils from '@/utils';
import * as tarConstants from '@/constants';

type FileType = {
  type: EntryType;
  path: string;
  stat: FileStat;
  content: string;
};

type DirectoryType = {
  type: EntryType;
  path: string;
  stat: FileStat;
  children: Array<FileType | DirectoryType>;
};

function splitHeaderData(data: Uint8Array) {
  const view = new DataView(data.buffer);
  return {
    name: tarUtils.parseFilePath(view),
    type: tarUtils.extractString(view, 156, 1),
    mode: tarUtils.extractOctal(view, 100, 8),
    uid: tarUtils.extractOctal(view, 108, 8),
    gid: tarUtils.extractOctal(view, 116, 8),
    size: tarUtils.extractOctal(view, 124, 12),
    mtime: tarUtils.extractOctal(view, 136, 12),
    format: tarUtils.extractString(view, 257, 6),
    version: tarUtils.extractString(view, 263, 2),
  };
}

const filenameArb = fc
  .string({ minLength: 1, maxLength: 32 })
  .filter((name) => !name.includes('/') && name !== '.' && name !== '..')
  .noShrink();

const fileContentArb = fc.string({ minLength: 0, maxLength: 4096 }).noShrink();

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

const fileArb = (parentPath: string = ''): fc.Arbitrary<FileType> =>
  fc
    .record({
      type: fc.constant(EntryType.FILE),
      path: filenameArb.map((name) => `${parentPath}/${name}`),
      content: fileContentArb,
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
      type: fc.constant(EntryType.DIRECTORY),
      path: filenameArb.map((name) => `${parentPath}/${name}`),
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

const tarHeaderArb = fc
  .record({
    path: filenameArb,
    uid: fc.nat(65535),
    gid: fc.nat(65535),
    size: fc.nat(65536),
    typeflag: fc.constantFrom('0', '5'),
  })
  .map(({ path, uid, gid, size, typeflag }) => {
    const header = new Uint8Array(tarConstants.BLOCK_SIZE);
    const type = typeflag as '0' | '5';
    const encoder = new TextEncoder();

    if (type === '5') size = 0;

    // Fill header fields
    header.set(encoder.encode(path), HeaderOffset.FILE_NAME);
    header.set(encoder.encode('0000777'), HeaderOffset.FILE_MODE);
    header.set(
      encoder.encode(uid.toString(8).padStart(7, '0')),
      HeaderOffset.OWNER_UID,
    );
    header.set(
      encoder.encode(gid.toString(8).padStart(7, '0')),
      HeaderOffset.OWNER_GID,
    );
    header.set(
      encoder.encode(size.toString(8).padStart(11, '0') + '\0'),
      HeaderOffset.FILE_SIZE,
    );
    header.set(encoder.encode('        '), HeaderOffset.CHECKSUM);
    header.set(encoder.encode(type), HeaderOffset.TYPE_FLAG);
    header.set(encoder.encode('ustar  '), HeaderOffset.USTAR_NAME);

    // Compute and set checksum
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.set(
      encoder.encode(checksum.toString(8).padStart(6, '0') + '\0 '),
      HeaderOffset.CHECKSUM,
    );

    return { header, stat: { type, size, path, uid, gid } };
  })
  .noShrink();

const tarDataArb = tarHeaderArb
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
        const { header: headerBlock, stat } = header;
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
          header: headerBlock,
          data: data,
          encodedData: dataBlock,
          type: stat.type,
        };
      }),
  )
  .noShrink();

export type { FileType, DirectoryType };
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
