import * as tar from '@';

describe('index', () => {
  test('exports Generator, Parser, constants, errors, types, and utils', () => {
    expect('Generator' in tar).toBeTrue();
    expect('Parser' in tar).toBeTrue();
    expect('constants' in tar).toBeTrue();
    expect('errors' in tar).toBeTrue();
    expect('utils' in tar).toBeTrue();
    expect('types' in tar).toBeTrue();
  });
});

test('test', async () => {
  const fs = await import('fs');
  const generator = new tar.Generator();
  const fd = await fs.promises.open('./tmp/test.tar', 'w+');
  await fd.write(generator.generateFile('abc/def/file.txt', {size: 3}));
  await fd.write(generator.generateData(Buffer.from('123')));
  await fd.write(generator.generateEnd());
  await fd.write(generator.generateEnd());
  await fd.close();
});