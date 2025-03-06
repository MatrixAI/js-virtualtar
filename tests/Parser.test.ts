import { test } from '@fast-check/jest';
import fc from 'fast-check';
import Parser from '@/Parser';
import { HeaderOffset, ParserState } from '@/types';
import * as tarErrors from '@/errors';
import * as tarUtils from '@/utils';
import * as tarConstants from '@/constants';
import * as utils from './utils';

describe('parsing archive blocks', () => {
  test.prop([utils.tarHeaderArb()])(
    'should parse headers with correct state',
    ({ headers, stat }) => {
      const { type, path, uid, gid } = stat;
      const parser = new Parser();
      const token = parser.write(headers[0]);

      expect(token?.type).toEqual('header');
      if (token?.type !== 'header') tarUtils.never('Token type');

      // @ts-ignore: accessing protected member for state analysis
      const state = parser.state;

      switch (type) {
        case '0':
          // If there is no data, then another header can be parsed immediately
          expect(token.fileType).toEqual('file');
          if (stat.size !== 0) expect(state).toEqual(ParserState.DATA);
          else expect(state).toEqual(ParserState.READY);
          break;
        case '5':
          expect(state).toEqual(ParserState.READY);
          expect(token.fileType).toEqual('directory');
          break;
        case 'x':
          expect(state).toEqual(ParserState.DATA);
          expect(token.fileType).toEqual('metadata');
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
        tarErrors.ErrorVirtualTarParserInvalidHeader,
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
        tarErrors.ErrorVirtualTarParserBlockSize,
      );
    },
  );

  test.prop(
    [utils.tarHeaderArb(), fc.uint8Array({ minLength: 8, maxLength: 8 })],
    {
      numRuns: 1,
    },
  )(
    'should fail to parse header with an invalid checksum',
    ({ headers }, checksum) => {
      headers[0].set(checksum, HeaderOffset.CHECKSUM);
      const parser = new Parser();
      expect(() => parser.write(headers[0])).toThrowError(
        tarErrors.ErrorVirtualTarParserInvalidHeader,
      );
    },
  );

  describe('parsing end of archive', () => {
    test('should parse end of archive', () => {
      const parser = new Parser();

      const token1 = parser.write(new Uint8Array(tarConstants.BLOCK_SIZE));
      expect(token1).toBeUndefined();
      // @ts-ignore: accessing protected member for state analysis
      expect(parser.state).toEqual(ParserState.NULL);

      const token2 = parser.write(new Uint8Array(tarConstants.BLOCK_SIZE));
      expect(token2?.type).toEqual('end');
      // @ts-ignore: accessing protected member for state analysis
      expect(parser.state).toEqual(ParserState.ENDED);
    });

    test.prop([utils.tarHeaderArb()], { numRuns: 1 })(
      'should fail if end of archive is malformed',
      ({ headers }) => {
        const parser = new Parser();

        const token1 = parser.write(new Uint8Array(tarConstants.BLOCK_SIZE));
        expect(token1).toBeUndefined();

        expect(() => parser.write(headers[0])).toThrowError(
          tarErrors.ErrorVirtualTarParserEndOfArchive,
        );
      },
    );

    test.prop([utils.tarHeaderArb()], { numRuns: 1 })(
      'should fail if data is written after parser ending',
      ({ headers }) => {
        const parser = new Parser();
        // @ts-ignore: updating parser state for testing
        parser.state = ParserState.ENDED;

        expect(() => parser.write(headers[0])).toThrowError(
          tarErrors.ErrorVirtualTarParserEndOfArchive,
        );
      },
    );
  });
});

describe('parsing extended metadata', () => {
  test.prop([utils.tarHeaderArb({ minLength: 256, maxLength: 512 })], {
    numRuns: 1,
  })('should create pax header with long paths', ({ headers }) => {
    const parser = new Parser();
    const token = parser.write(headers[0]);
    expect(token?.type).toEqual('header');
    // @ts-ignore: accessing protected member for state analysis
    expect(parser.state).toEqual(ParserState.DATA);
  });

  test.prop([utils.tarHeaderArb({ minLength: 256, maxLength: 512 })], {
    numRuns: 1,
  })('should retrieve full file path from pax header', ({ headers, stat }) => {
    // Get the header size
    const parser = new Parser();
    const paxHeader = parser.write(headers[0]);
    if (paxHeader == null || paxHeader.type !== 'header') {
      throw new Error('Invalid state');
    }
    const size = paxHeader.fileSize;

    // Concatenate all the data into a single array
    const data = new Uint8Array(size);
    let offset = 0;
    for (const header of headers.slice(1, -1)) {
      const paxData = parser.write(header);
      if (paxData == null || paxData.type !== 'data') {
        throw new Error('Invalid state');
      }
      data.set(paxData.data, offset);
      offset += tarConstants.BLOCK_SIZE;
    }

    // Parse the data into a record
    const parsedHeader = tarUtils.decodeExtendedHeader(data);
    expect(parsedHeader.path).toEqual(stat.path);

    // The actual path in the header is ignored if the PAX header contains
    // metadata for the file path. Ignoring this is dependant on the user
    // instead of on the parser.
  });
});
