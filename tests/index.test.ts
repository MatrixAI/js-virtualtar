import { writeArchive } from '@/Generator';

describe('index', () => {
  test('test', async () => {
    await expect(
      writeArchive(
        '/home/aryanj/Downloads/tar/FILE.txt',
        '/home/aryanj/Downloads/tar/FILE.tar',
      ),
    ).toResolve();
  });
});
