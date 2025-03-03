import { test } from '@fast-check/jest';
import { generateHeader, generateNullChunk } from '@/Generator';
import { EntryType } from '@/types';
import * as tarUtils from '@/utils';
import { dirArb, fileArb, splitHeaderData } from './utils';

describe('archive generation', () => {
  test.prop([fileArb()])('should generate a valid file header', (file) => {
    // Generate and split the header
    const header = generateHeader(file.path, EntryType.FILE, file.stat);
    const { name, type, mode, uid, gid, size, mtime, format, version } =
      splitHeaderData(header);

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
  });

  test.prop([dirArb(0)])('should generate a valid directory header', (file) => {
    // Generate and split the header
    const header = generateHeader(file.path, EntryType.DIRECTORY, file.stat);
    const { name, type, mode, uid, gid, size, mtime, format, version } =
      splitHeaderData(header);

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
  });

  test('should generate a valid null chunk', () => {
    expect(generateNullChunk().reduce((sum, byte) => (sum += byte))).toBe(0);
  });
});
