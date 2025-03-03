import { test } from '@fast-check/jest';
import fc from 'fast-check';
import Parser from '@/Parser';
import { generateNullChunk } from '@/Generator';
import { HeaderOffset, ParserState } from '@/types';
import * as tarErrors from '@/errors';
import * as tarUtils from '@/utils';
import * as tarConstants from '@/constants';
import { tarHeaderArb } from './utils';

describe('archive parsing', () => {
  test.prop([tarHeaderArb])(
    'should parse headers with correct state',
    ({ header, stat }) => {
      const { type, path, uid, gid } = stat;
      const parser = new Parser();
      const token = parser.write(header);

      expect(token?.type).toEqual('header');
      if (token?.type !== 'header') tarUtils.never('Token type');

      // @ts-ignore: accessing protected member for state analysis
      const state = parser.state;

      switch (type) {
        case '0':
          expect(state).toEqual(ParserState.DATA);
          expect(token.fileType).toEqual('file');
          break;
        case '5':
          expect(state).toEqual(ParserState.READY);
          expect(token.fileType).toEqual('directory');
          break;
        default:
          tarUtils.never('Invalid state');
      }

      expect(token.filePath).toEqual(path);
      expect(token.ownerUid).toEqual(uid);
      expect(token.ownerGid).toEqual(gid);
    },
  );

  test.prop([tarHeaderArb])(
    'should parse headers with correct state',
    ({ header, stat }) => {
      const { type, path, uid, gid } = stat;
      const parser = new Parser();
      const token = parser.write(header);

      expect(token?.type).toEqual('header');
      if (token?.type !== 'header') tarUtils.never('Token type');

      // @ts-ignore: accessing protected member for state analysis
      const state = parser.state;

      switch (type) {
        case '0':
          expect(state).toEqual(ParserState.DATA);
          expect(token.fileType).toEqual('file');
          break;
        case '5':
          expect(state).toEqual(ParserState.READY);
          expect(token.fileType).toEqual('directory');
          break;
        default:
          tarUtils.never('Invalid state');
      }

      expect(token.filePath).toEqual(path);
      expect(token.ownerUid).toEqual(uid);
      expect(token.ownerGid).toEqual(gid);
    },
  );

  test.prop([fc.uint8Array({ minLength: 512, maxLength: 512 })])(
    'should fail to parse gibberish data',
    (data) => {
      // Make sure a null block doesn't get tested. It is reserved for ending a
      // tar archive.
      fc.pre(!tarUtils.isNullBlock(data));

      const parser = new Parser();
      expect(() => parser.write(data)).toThrowError(
        tarErrors.ErrorTarParserInvalidHeader,
      );
    },
  );

  test.prop([fc.uint8Array()])(
    'should fail to parse blocks with arbitrary size',
    (data) => {
      // Make sure a null block doesn't get tested. It is reserved for ending a
      // tar archive.
      fc.pre(data.length !== tarConstants.BLOCK_SIZE);

      const parser = new Parser();
      expect(() => parser.write(data)).toThrowError(
        tarErrors.ErrorTarParserBlockSize,
      );
    },
  );

  test.prop([tarHeaderArb, fc.uint8Array({ minLength: 8, maxLength: 8 })], {
    numRuns: 1,
  })(
    'should fail to parse header with an invalid checksum',
    ({ header }, checksum) => {
      header.set(checksum, HeaderOffset.CHECKSUM);
      const parser = new Parser();
      expect(() => parser.write(header)).toThrowError(
        tarErrors.ErrorTarParserInvalidHeader,
      );
    },
  );

  describe('parsing end of archive', () => {
    test('should parse end of archive', () => {
      const parser = new Parser();

      const token1 = parser.write(generateNullChunk());
      expect(token1).toBeUndefined();
      // @ts-ignore: accessing protected member for state analysis
      expect(parser.state).toEqual(ParserState.NULL);

      const token2 = parser.write(generateNullChunk());
      expect(token2?.type).toEqual('end');
      // @ts-ignore: accessing protected member for state analysis
      expect(parser.state).toEqual(ParserState.ENDED);
    });

    test.prop([tarHeaderArb], { numRuns: 1 })(
      'should fail if end of archive is malformed',
      ({ header }) => {
        const parser = new Parser();

        const token1 = parser.write(generateNullChunk());
        expect(token1).toBeUndefined();

        expect(() => parser.write(header)).toThrowError(
          tarErrors.ErrorTarParserEndOfArchive,
        );
      },
    );

    test.prop([tarHeaderArb], { numRuns: 1 })(
      'should fail if data is written after parser ending',
      ({ header }) => {
        const parser = new Parser();
        // @ts-ignore: updating parser state for testing
        parser.state = ParserState.ENDED;

        expect(() => parser.write(header)).toThrowError(
          tarErrors.ErrorTarParserEndOfArchive,
        );
      },
    );
  });
});
