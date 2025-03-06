enum EntryType {
  FILE = '0',
  DIRECTORY = '5',
  EXTENDED = 'x',
}

enum ExtendedHeaderKeywords {
  FILE_PATH = 'path',
}

enum HeaderOffset {
  FILE_NAME = 0,
  FILE_MODE = 100,
  OWNER_UID = 108,
  OWNER_GID = 116,
  FILE_SIZE = 124,
  FILE_MTIME = 136,
  CHECKSUM = 148,
  TYPE_FLAG = 156,
  LINK_NAME = 157,
  USTAR_NAME = 257,
  USTAR_VERSION = 263,
  OWNER_USERNAME = 265,
  OWNER_GROUPNAME = 297,
  DEVICE_MAJOR = 329,
  DEVICE_MINOR = 337,
  FILE_NAME_PREFIX = 345,
}

enum HeaderSize {
  FILE_NAME = 100,
  FILE_MODE = 8,
  OWNER_UID = 8,
  OWNER_GID = 8,
  FILE_SIZE = 12,
  FILE_MTIME = 12,
  CHECKSUM = 8,
  TYPE_FLAG = 1,
  LINK_NAME = 100,
  USTAR_NAME = 6,
  USTAR_VERSION = 2,
  OWNER_USERNAME = 32,
  OWNER_GROUPNAME = 32,
  DEVICE_MAJOR = 8,
  DEVICE_MINOR = 8,
  FILE_NAME_PREFIX = 155,
}

type FileStat = {
  mode?: number;
  uid?: number;
  gid?: number;
  size?: number;
  mtime?: Date;
};

type TokenHeader = {
  type: 'header';
  fileType: 'file' | 'directory' | 'metadata';
  filePath: string;
  fileMode: number;
  ownerUid: number;
  ownerGid: number;
  fileSize: number;
  fileMtime: Date;
  ownerName: string;
  ownerUserName: string;
  ownerGroupName: string;
};

type TokenData = {
  type: 'data';
  data: Uint8Array;
};

type TokenEnd = {
  type: 'end';
};

enum FileType {
  FILE,
  DIRECTORY,
}

enum ParserState {
  READY,
  DATA,
  NULL,
  ENDED,
}

enum GeneratorState {
  READY,
  DATA,
  NULL,
  ENDED,
}

export type { FileStat, TokenHeader, TokenData, TokenEnd };

export {
  EntryType,
  ExtendedHeaderKeywords,
  HeaderOffset,
  HeaderSize,
  FileType,
  ParserState,
  GeneratorState,
};
