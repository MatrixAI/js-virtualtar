type FileType = 'file' | 'directory' | 'extended';

enum EntryType {
  FILE = '0',
  DIRECTORY = '5',
  EXTENDED = 'x',
}

enum MetadataKeywords {
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
  size?: number;
  mode?: number;
  mtime?: Date;
  uid?: number;
  gid?: number;
  uname?: string;
  gname?: string;
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
  end: boolean;
};

type TokenEnd = {
  type: 'end';
};

enum ParserState {
  HEADER,
  DATA,
  NULL,
  ENDED,
}

enum GeneratorState {
  HEADER,
  DATA,
  NULL,
  ENDED,
}

enum VirtualTarState {
  GENERATOR,
  PARSER,
}

type ParsedFile = {
  type: 'file';
  path: string;
  stat: FileStat;
  content: Uint8Array;
};

type ParsedDirectory = {
  type: 'directory';
  path: string;
  stat: FileStat;
};

type ParsedMetadata = {
  type: 'metadata';
};

type ParsedEmpty = {
  type: 'empty';
  awaitingData: boolean;
};

export type {
  FileType,
  FileStat,
  TokenHeader,
  TokenData,
  TokenEnd,
  ParsedFile,
  ParsedDirectory,
  ParsedMetadata,
  ParsedEmpty,
};

export {
  EntryType,
  MetadataKeywords,
  HeaderOffset,
  HeaderSize,
  ParserState,
  GeneratorState,
  VirtualTarState,
};
