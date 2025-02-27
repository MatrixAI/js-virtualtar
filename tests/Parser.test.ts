import { test } from '@fast-check/jest';
import fc from 'fast-check';
import { ParserState } from '@/types';
import Parser from '@/Parser';
import * as tarUtils from '@/utils';
import * as tarConstants from '@/constants';
import { tarHeaderArb, tarDataArb } from './utils';

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

  test.prop([tarDataArb])(
    'should parse file with data',
    ({ header, type, data, encodedData }) => {
      // Make sure we are only testing against files
      fc.pre(type === '0');

      const parser = new Parser();
      const headerToken = parser.write(header);

      expect(headerToken?.type).toEqual('header');
      if (headerToken?.type !== 'header') tarUtils.never('Token type');

      // @ts-ignore: accessing protected member for state analysis
      const state = parser.state;
      expect(state).toEqual(ParserState.DATA);

      let accumulator = '';
      const decoder = new TextDecoder();
      const totalBlocks = Math.ceil(
        encodedData.length / tarConstants.BLOCK_SIZE,
      );
      for (let i = 0; i < totalBlocks; i++) {
        const offset = i * tarConstants.BLOCK_SIZE;

        const dataToken = parser.write(
          encodedData.slice(offset, offset + tarConstants.BLOCK_SIZE),
        );
        expect(dataToken?.type).toEqual('data');
        if (dataToken?.type !== 'data') tarUtils.never('Token type');

        const content = decoder.decode(dataToken.data);
        accumulator += content;
      }
      expect(data).toEqual(accumulator);
    },
  );
});
