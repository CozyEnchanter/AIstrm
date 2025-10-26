import {
  BuiltinServiceId,
  createLogger,
  getTimeTakenSincePoint,
} from '../../utils/index.js';
import {
  BuiltinDebridServices,
  DebridFile,
  getDebridService,
  selectFileInTorrentOrNZB,
  Torrent,
  TorrentWithSelectedFile,
  NZBWithSelectedFile,
  NZB,
  isSeasonWrong,
  isEpisodeWrong,
  isTitleWrong,
  DebridDownload,
  isNotVideoFile,
} from '../../debrid/index.js';
import { PTT } from '../../parser/index.js';
import { ParseResult } from 'go-ptt';
import { preprocessTitle } from '../../parser/utils.js';

// we have a list of torrents which need to be
// - 1. checked for instant availability for each configured debrid service
// - 2. pick a file from file list if available
// - 3. return list of torrents but with service info too.

const logger = createLogger('debrid');

// export function

interface Metadata {
  titles: string[];
  season?: number;
  episode?: number;
  absoluteEpisode?: number;
}

export function validateInfoHash(
  infoHash: string | undefined
): string | undefined {
  return infoHash && /^[a-f0-9]{40}$/i.test(infoHash) ? infoHash : undefined;
}

export function extractTrackersFromMagnet(magnet: string): string[] {
  return new URL(magnet.replace('&amp;', '&')).searchParams.getAll('tr');
}

export function extractInfoHashFromMagnet(magnet: string): string | undefined {
  return magnet
    .match(/(?:urn(?::|%3A)btih(?::|%3A))([a-f0-9]{40})/i)?.[1]
    ?.toLowerCase();
}

export async function processTorrents(
  torrents: Torrent[],
  debridServices: BuiltinDebridServices,
  stremioId: string,
  metadata?: Metadata,
  clientIp?: string
): Promise<{
  results: TorrentWithSelectedFile[];
  errors: { serviceId: BuiltinServiceId; error: Error }[];
}> {
  if (torrents.length === 0) {
    return { results: [], errors: [] };
  }
  const results: TorrentWithSelectedFile[] = [];
  const errors: { serviceId: BuiltinServiceId; error: Error }[] = [];

  // Run all service checks in parallel and collect both results and errors
  const servicePromises = debridServices.map(async (service) => {
    try {
      const serviceResults = await processTorrentsForDebridService(
        torrents,
        service,
        stremioId,
        metadata,
        clientIp
      );
      return { serviceId: service.id, results: serviceResults, error: null };
    } catch (error) {
      logger.error(
        `Error processing torrents for ${service.id}: ${error}`,
        error
      );
      return { serviceId: service.id, results: [], error };
    }
  });

  const settledResults = await Promise.all(servicePromises);

  for (const { results: serviceResults, error, serviceId } of settledResults) {
    if (serviceResults && serviceResults.length > 0) {
      results.push(...serviceResults);
    }
    if (error instanceof Error) {
      errors.push({ serviceId, error });
    }
  }

  return { results, errors };
}

async function processTorrentsForDebridService(
  torrents: Torrent[],
  service: BuiltinDebridServices[number],
  stremioId: string,
  metadata?: Metadata,
  clientIp?: string
): Promise<TorrentWithSelectedFile[]> {
  const startTime = Date.now();
  const debridService = getDebridService(
    service.id,
    service.credential,
    clientIp
  );

  const results: TorrentWithSelectedFile[] = [];

  const magnetCheckResults = await debridService.checkMagnets(
    torrents.map((torrent) => torrent.hash),
    stremioId
  );
  // const magnetCheckTime = getTimeTakenSincePoint(startTime);
  logger.debug(`Retrieved magnet status from debrid`, {
    service: debridService.serviceName,
    magnetCount: torrents.length,
    time: getTimeTakenSincePoint(startTime),
  });

  // Parse only torrent titles and perform validation checks
  const torrentTitles = torrents.map((torrent) => torrent.title ?? '');
  const parsedTitles = await PTT.parse(torrentTitles);
  const parsedTitlesMap = new Map<string, ParseResult>();
  for (const [index, result] of parsedTitles.entries()) {
    if (result) {
      parsedTitlesMap.set(torrentTitles[index], result);
    }
  }

  // Filter torrents that pass validation checks
  const validTorrents: {
    torrent: Torrent;
    magnetCheckResult: DebridDownload | undefined;
    parsedTitle: ParseResult;
  }[] = [];
  for (const torrent of torrents) {
    const magnetCheckResult = magnetCheckResults.find(
      (result) => result.hash === torrent.hash
    );
    const parsedTorrent = parsedTitlesMap.get(torrent.title ?? '');

    if (metadata && parsedTorrent) {
      const preprocessedTitle = preprocessTitle(
        parsedTorrent.title,
        torrent.title ?? '',
        metadata.titles
      );
      if (
        torrent.confirmed !== true &&
        isTitleWrong({ title: preprocessedTitle }, metadata)
      ) {
        continue;
      }
      if (isSeasonWrong(parsedTorrent, metadata)) {
        continue;
      }
      if (isEpisodeWrong(parsedTorrent, metadata)) {
        continue;
      }
    }

    validTorrents.push({
      torrent,
      magnetCheckResult,
      parsedTitle: parsedTorrent!,
    });
  }

  // Parse files only for valid torrents
  const allFileStrings: string[] = [];
  for (const { magnetCheckResult } of validTorrents) {
    if (magnetCheckResult?.files && Array.isArray(magnetCheckResult.files)) {
      for (const file of magnetCheckResult.files) {
        if (isNotVideoFile(file)) continue;
        allFileStrings.push(file.name ?? '');
      }
    }
  }

  // Parse all file strings in one call
  const allParsedFiles = await PTT.parse(allFileStrings);
  const parsedFiles = new Map<string, ParseResult>();
  for (const [index, result] of allParsedFiles.entries()) {
    if (result) {
      parsedFiles.set(allFileStrings[index], result);
    }
  }

  const processingStart = Date.now();
  for (const { torrent, magnetCheckResult, parsedTitle } of validTorrents) {
    let file: DebridFile | undefined;

    file = magnetCheckResult
      ? await selectFileInTorrentOrNZB(
          torrent,
          magnetCheckResult,
          parsedFiles,
          metadata,
          {
            useLevenshteinMatching: false,
          }
        )
      : { name: torrent.title, size: torrent.size, index: -1 };

    if (file) {
      results.push({
        ...torrent,
        file,
        service: {
          id: service.id,
          cached: magnetCheckResult?.status === 'cached',
          owned: false,
        },
      });
    }
  }

  logger.debug(
    `Processed ${torrents.length} torrents for ${service.id} in ${getTimeTakenSincePoint(processingStart)}`
  );

  return results;
}

export async function processTorrentsForP2P(
  torrents: Torrent[],
  metadata?: Metadata
): Promise<TorrentWithSelectedFile[]> {
  const results: TorrentWithSelectedFile[] = [];

  // Parse only torrent titles and perform validation checks
  const torrentTitles = torrents.map((torrent) => torrent.title ?? '');
  const parsedTitles = await PTT.parse(torrentTitles);
  const parsedTitlesMap = new Map<string, ParseResult>();
  for (const [index, result] of parsedTitles.entries()) {
    if (result) {
      parsedTitlesMap.set(torrentTitles[index], result);
    }
  }

  // Filter torrents that pass validation checks
  const validTorrents: { torrent: Torrent; parsedTitle: ParseResult }[] = [];
  for (const torrent of torrents) {
    const parsedTorrent = parsedTitlesMap.get(torrent.title ?? '');
    if (metadata && parsedTorrent) {
      if (isSeasonWrong(parsedTorrent, metadata)) {
        continue;
      }
      if (isEpisodeWrong(parsedTorrent, metadata)) {
        continue;
      }
    }
    validTorrents.push({ torrent, parsedTitle: parsedTorrent! });
  }

  // Parse files only for valid torrents
  const allFileStrings: string[] = [];
  for (const { torrent } of validTorrents) {
    if (torrent.files && Array.isArray(torrent.files)) {
      for (const file of torrent.files) {
        if (isNotVideoFile(file)) continue;
        allFileStrings.push(file.name ?? '');
      }
    }
  }

  const allParsedFiles = await PTT.parse(allFileStrings);
  const parsedFiles = new Map<string, ParseResult>();
  for (const [index, result] of allParsedFiles.entries()) {
    if (result) {
      parsedFiles.set(allFileStrings[index], result);
    }
  }

  for (const { torrent } of validTorrents) {
    let file: DebridFile | undefined;

    file = torrent.files
      ? await selectFileInTorrentOrNZB(
          torrent,
          {
            id: 'p2p',
            name: torrent.title,
            size: torrent.size,
            status: 'downloaded',
            files: torrent.files,
          },
          parsedFiles,
          metadata,
          {
            useLevenshteinMatching: false,
          }
        )
      : undefined;

    if (file) {
      results.push({
        ...torrent,
        file,
      });
    }
  }

  return results;
}

export async function processNZBs(
  nzbs: NZB[],
  debridServices: BuiltinDebridServices,
  stremioId: string,
  metadata?: Metadata,
  clientIp?: string
): Promise<{
  results: NZBWithSelectedFile[];
  errors: { serviceId: BuiltinServiceId; error: Error }[];
}> {
  if (nzbs.length === 0) {
    return { results: [], errors: [] };
  }
  const results: NZBWithSelectedFile[] = [];
  const errors: { serviceId: BuiltinServiceId; error: Error }[] = [];

  const servicePromises = debridServices.map(async (service) => {
    try {
      const serviceResults = await processNZBsForDebridService(
        nzbs,
        service,
        stremioId,
        metadata,
        clientIp
      );
      return { serviceId: service.id, results: serviceResults, error: null };
    } catch (error) {
      logger.error(`Error processing NZBs for ${service.id}: ${error}`, error);
      return { serviceId: service.id, results: [], error };
    }
  });

  const settledResults = await Promise.all(servicePromises);

  for (const { results: serviceResults, error, serviceId } of settledResults) {
    if (serviceResults && serviceResults.length > 0) {
      results.push(...serviceResults);
    }
    if (error instanceof Error) {
      errors.push({ serviceId, error });
    }
  }

  return { results, errors };
}

async function processNZBsForDebridService(
  nzbs: NZB[],
  service: BuiltinDebridServices[number],
  stremioId: string,
  metadata?: Metadata,
  clientIp?: string
): Promise<NZBWithSelectedFile[]> {
  const startTime = Date.now();
  const debridService = getDebridService(
    service.id,
    service.credential,
    clientIp
  );

  if (!debridService.supportsUsenet || !debridService.checkNzbs) {
    throw new Error(`Service ${service.id} does not support usenet`);
  }

  const results: NZBWithSelectedFile[] = [];

  const nzbCheckResults = await debridService.checkNzbs(
    nzbs.map((nzb) => nzb.hash)
  );

  logger.debug(`Retrieved NZB status from debrid`, {
    service: debridService.serviceName,
    nzbCount: nzbs.length,
    time: getTimeTakenSincePoint(startTime),
  });

  // Parse only NZB titles and perform validation checks
  const nzbTitles = nzbs.map((nzb) => nzb.title ?? '');
  const parsedTitles = await PTT.parse(nzbTitles);
  const parsedTitlesMap = new Map<string, ParseResult>();
  for (const [index, result] of parsedTitles.entries()) {
    if (result) {
      parsedTitlesMap.set(nzbTitles[index], result);
    }
  }

  // Filter NZBs that pass validation checks
  const validNZBs: {
    nzb: NZB;
    nzbCheckResult: any;
    parsedTitle: ParseResult;
  }[] = [];
  for (const nzb of nzbs) {
    const nzbCheckResult = nzbCheckResults.find(
      (result) => result.hash === nzb.hash
    );
    const parsedNzb = parsedTitlesMap.get(nzb.title ?? '');
    if (metadata && parsedNzb) {
      if (isSeasonWrong(parsedNzb, metadata)) {
        continue;
      }
      if (isEpisodeWrong(parsedNzb, metadata)) {
        continue;
      }
    }
    validNZBs.push({ nzb, nzbCheckResult, parsedTitle: parsedNzb! });
  }

  // Parse files only for valid NZBs
  const allFileStrings: string[] = [];
  for (const { nzbCheckResult } of validNZBs) {
    if (nzbCheckResult?.files && Array.isArray(nzbCheckResult.files)) {
      for (const file of nzbCheckResult.files) {
        if (isNotVideoFile(file)) continue;
        allFileStrings.push(file.name ?? '');
      }
    }
  }

  const allParsedFiles = await PTT.parse(allFileStrings);
  const parsedFiles = new Map<string, ParseResult>();
  for (const [index, result] of allParsedFiles.entries()) {
    if (result) {
      parsedFiles.set(allFileStrings[index], result);
    }
  }

  const processingStart = Date.now();
  for (const { nzb, nzbCheckResult } of validNZBs) {
    let file: DebridFile | undefined;

    file = nzbCheckResult
      ? await selectFileInTorrentOrNZB(
          nzb,
          nzbCheckResult,
          parsedFiles,
          metadata
        )
      : { name: nzb.title, size: nzb.size, index: -1 };

    if (file) {
      results.push({
        ...nzb,
        file,
        service: {
          id: service.id,
          cached: nzbCheckResult?.status === 'cached',
          owned: false,
        },
      });
    }
  }

  logger.debug(
    `Processed ${nzbs.length} NZBs for ${service.id} in ${getTimeTakenSincePoint(processingStart)}`
  );

  return results;
}
