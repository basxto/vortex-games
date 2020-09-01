const fsOrig = require('fs-extra');
const _ = require('lodash');
const path = require('path');
const shortid = require('shortid');
const walk = require('turbowalk').default;
const { actions, fs, log, selectors, util } = require('vortex-api');
const { default: IniParser, WinapiFormat } = require('vortex-parse-ini');

const GAME_ID = 'microsoftflightsimulator';
const MS_APPID = 'Microsoft.FlightSimulator';
const PACKAGE_ID = '8wekyb3d8bbwe';
const STEAM_APPID = '1250410';
const EXE_NAME = 'FlightSimulator.exe';

const STOP_PATTERNS = [
  'manifest.json',
];

function toWordExp(input) {
  return '(^|/)' + input + '(/|$)';
}

function findGame() {
  // game is currently available on Steam and the Microsoft store
  const disco = util.GameStoreHelper.findByAppId([MS_APPID, STEAM_APPID]);
  if (!!disco) {
    return disco.gamePath;
  } else {
    return undefined;
  }
}

function findLocalCache() {
  const makeCachePath = (appName) =>
    path.join(process.env.LOCALAPPDATA, 'packages', `${appName}_${PACKAGE_ID}`, 'LocalCache');

  const opt1 = makeCachePath(MS_APPID);
  // according to various pages this should exist when installed through Steam
  const opt2 = makeCachePath('Microsoft.FlightDashboard')

  try {
    fs.statSync(opt1);
    return opt1;
  } catch (err) {
    fs.statSync(opt2);
    return opt2;
  }
}

function parseOPTObject(lines, offset) {
  const res = {};
  let i = offset;
  while (i < lines.length) {
    if (lines[i].length === 0) {
      // nop
    } else if (lines[i] === '}') {
      break;
    } else if (lines[i].startsWith('{')) {
      // oooh, an object, how exciting...
      name = lines[i].slice(1);
      const [value, newOffset] = parseOPTObject(lines, i + 1);
      res[name] = value;
      i = newOffset;
    } else {
      const [name, ...valueArr] = lines[i].split(' ');
      const value = valueArr.join(' ');
      res[name] = value;
      // +(string) converts string to number and it fails if the entire string
      // can't be converted - unlike parseFloat which converts as much as it can match and
      // just ignores if there is more
      const num = +(value);
      if (!isNaN(num)) {
        res[name] = num;
      } else if (value.startsWith('"') && value.endsWith('"')) {
        res[name] = value.slice(1, value.length - 1);
      }
    }
    ++i;
  }

  return [res, i];
}

function parseOPT(filePath) {
  const data = fs.readFileSync(filePath, { encoding: 'utf-8' });
  return parseOPTObject(data.split('\n').map(line => line.trimLeft()), 0)[0];
}

const getPackagesPath = (() => {
  // finding the mod path for this game is - interesting. The user can configure a custom
  // data path that then contains the modding directory, otherwise there is a default which
  // differs depending on which store the game was bought on

  // this involves several disk ops and parsing a config file and it has to be
  // synchronous because of the api so cache the result
  let cachedPath;

  return () => {
    if (cachedPath === undefined) {
      const basePath = findLocalCache();
      // now, if the user customized the path we should be able to find the actual path in this
      // config file

      const usercfg = parseOPT(path.join(basePath, 'UserCfg.opt'));
      if (usercfg['InstalledPackagesPath'] !== undefined) {
        // configured
        cachedPath = path.join(usercfg['InstalledPackagesPath']);
      } else {
        // default
        cachedPath = path.join(basePath, 'Packages');
      }
    }

    return cachedPath;
  }
})();

function findModPath() {
  return path.join(getPackagesPath(), 'Community');
}

async function requiresLauncher(gamePath) {
  // the windows store application has this silly permission system where we can't
  // even stat the files in the game directory, so if we can't stat the exe, it's a safe bet
  // we have to go through the launcher
  try {
    await fsOrig.stat(path.join(gamePath, EXE_NAME))
  } catch (err) {
    return {
        launcher: 'xbox',
        addInfo: {
          appId: MS_APPID,
          parameters: [
            { appExecName: 'App' },
          ],
        }
    };
  }
}

function toFileId(filePath) {
  return path.basename(filePath).toUpperCase();
}

function toWinTimestamp(input) {
  // stat.mtimeMS is a js timestamp (milliseconds since 1 Jan 1970 00:00),
  // the layout.json file expects 100-ns intervals since 1 Jan 1601 00:00).
  // Why 100-ns intervals? Why 1601? Because Microsoft!
  return input * 10000 + 116444736000000000;
}

/**
 * installer for replacer mods that aren't packaged in a way that we can directly
 * unpack to the Community directory.
 * This will use the list of official files to try and figure out where the file is _supposed_
 * to go, such that it actually replaces something
 */
function makeInstallReplacer(api) {
  return async (files, tempPath) => {
    let possibleTypes = new Set();
    let possibleTargets;

    const filesFiltered = files.filter(filePath => !filePath.endsWith(path.sep));

    // first things first, we have to figure out which object (e.g. which aircraft) is being
    // replaced/modified here. For that we go through the list of official files cached earlier
    // to see which object(s) contains the files in the replacer mod

    for (let file of filesFiltered) {
      const fileId = toFileId(file);
      Object.keys(sOfficialFileList).forEach(type => {
        const targets = sOfficialFileList[type][fileId];
        if (targets !== undefined) {
          possibleTypes.add(type);
          const targetIds = targets.map(iter => `${iter.type}:${iter.itemId}`);
          // possible targets are only items that contain _all_ the files in the mod, so
          // what we're interested in is the intersection of targets of each of the files
          if (possibleTargets === undefined) {
            possibleTargets = new Set(targetIds);
          } else {
            possibleTargets = new Set([...targetIds].filter(x => possibleTargets.has(x)));
          }
        }
      });
    }

    // TODO: we should probably check possible types, is it plausible a mod could
    //   fit - say - an aircraft and an airport? How should we deal with that?

    if ((possibleTargets === undefined) || (possibleTargets.size === 0)) {
      // not a single file matched anything in the file list? huh, this is probably not a replacer
      // after all, is it?
      log('warn', 'mod was expected to be a replacer but didn\'t match any official content');
      return {
        instructions: [
          {
            type: 'error',
            value: 'warning',
            source: 'Mod structure not recognized, this mod will probably not work correctly. '
                  + 'This can happen - for example - if you try to install livery replacements '
                  + 'for an aircraft not included in your edition of the game.',
          },
        ].concat(filesFiltered.map(filePath => ({
          type: 'copy',
          source: filePath,
          destination: filePath,
        })))
      };
    }

    possibleTargets = Array.from(possibleTargets);

    if (possibleTargets.length > 1) {
      // multiple possible targets, ask the user
      const result = await api.showDialog('question', 'Pick target', {
        text: 'The way this mod is structured it looks like it\'s intended to replace official '
            + 'content but we can\'t automatically determine which. Please pick from the '
            + 'possible options below to complete the installation.',
        choices: Array.from(possibleTargets).map((target, idx) => ({
          id: target, text: target.split(':')[1], value: idx === 0,
        }))
      }, [
        { label: 'Continue' },
      ]);
      possibleTargets = [Object.keys(result.input).find(target => result.input[target])];
    }

    // ok, at this point we know which target to install into, either it was clear from the included
    // files or the user selected something, now for setting up the directory structure correctly.
    // unfortunately at this point we have to repeat some of the work done earlier

    const [type, actualTarget] = possibleTargets[0].split(':');

    const mapPathToTarget = (sourcePath, targetId) => {
      const fileId = toFileId(sourcePath);
      if (sOfficialFileList[type][fileId] !== undefined) {
        const target = sOfficialFileList[type][fileId]
          .find(iter => iter.itemId === targetId);
        if (target !== undefined) {
          return target.relPath;
        }
        // the else case should never happen, we wouldn't have considered tha target as an option
      }

      // if there file doesn't exist in official files it's probably a readme or something where
      // the location doesn't matter anyway
      return sourcePath;
    };

    let instructions = filesFiltered
      .map(filePath => ({
        type: 'copy',
        source: filePath,
        destination: mapPathToTarget(filePath, actualTarget),
      }));

    const layout = Promise.all(filesFiltered.map(async filePath => {
      const stat = fs.stat(path.join(tempPath, filePath));
      return {
        path: filePath,
        size: stat.size,
        date: toWinTimestamp(stat.mtimeMS),
      };
    }));

    instructions.push({
      type: 'generatefile',
      data: Buffer.from(JSON.stringify(layout, undefined, 2), 'utf8').toString('base64'),
    });
    return { instructions };
  };
}

async function testSupportedReplacer(files, gameId) {
  // apply for any mod that contains no manifest.
  // this may have to be revised at some point
  const supported = (gameId === GAME_ID) &&
    (files.find(file => ['manifest.json', 'layout.json'].includes(path.basename(file).toLowerCase())) === undefined);
  return Promise.resolve({
    supported,
    requiredFiles: [],
  });
}

// initialized when the game is activated.
// structure:
// {
//    "aircraft": {
//      "<filename uppercased>": [
//         "<relative file path 1>",
//         "<relative file path 2>",
//      ]
//    }
//    "airport" {
//      ...
//    }
// }
let sOfficialFileList = {};

async function setup() {
  const packagesPath = getPackagesPath();

  await fs.ensureDirWritableAsync(path.join(packagesPath, 'Community'));

  // official plane data has a directory structure like this:
  //   asobo-aircraft-c152\SimObjects\Airplanes\Asobo_C152
  // that directory then contains a bunch of config files and - in subdirectories - textures
  // and such.
  // some mods will be distributed as just a cfg file for example, with no way for the software
  // to know which plane it's intended for.
  // To help, we create a map of just the file names mapped to all possible subdirectories they
  // belong into. If the files in a mod are supposed to replace an existing file but lacking
  // the directory structure we don't know which, we can use that to determine 

  const officialPath = path.join(packagesPath, 'Official', 'OneStore');
  const officialItems = await fs.readdirAsync(officialPath);

  for (let item of officialItems) {
    const [publisher, type, name] = item.split('-');
    if (sOfficialFileList[type] === undefined) {
      sOfficialFileList[type] = {};
    }
    // there are separate libraries there we probably don't care about
    if ((publisher === 'asobo') && (name !== undefined)) {
      const itemPath = path.join(officialPath, item);
      await walk(itemPath, entries => {
        for (let entry of entries) {
          util.setdefault(sOfficialFileList[type], path.basename(entry.filePath).toUpperCase(), [])
            .push({
              type,
              itemId: name,
              relPath: path.relative(itemPath, entry.filePath),
            });
        }
      });
    }
  }
}

function isConfig(filePath) {
  return path.basename(filePath) === 'aircraft.cfg';
}

function makeTestMerge(api) {
  return (game, gameDiscovery) => {
    const installPath = selectors.installPathForGame(api.store.getState(), game.id);
    return {
      baseFiles: (deployedFiles) => {
        // this ensures that for every config we only use one file as the merge basis.
        // Which one we pick _should_ be irrelevant as the merge later one will take load
        // order into account
        const mergeBases = deployedFiles
          .filter(file => isConfig(file.relPath))
          .reduce((prev, file) => {
            const id = file.relPath.toUpperCase();
            if (prev[id] === undefined) {
              prev[id] = file;
            }
            return prev;
          }, {});

        return Array.from(Object.values(mergeBases)).map(file => ({
          in: path.join(installPath, file.source, file.relPath),
          out: file.relPath,
        }));
      },
      filter: filePath => isConfig(filePath),
    };
  }
}

// as far as I can tell, the game doesn't seem to _use_ ui_manufacturer from liveries,
// always seems to use the one from FLTSIM.0. Not sure if this is a bug and gets fixed
// at some point, but it kind of makes sense
const LOCALIZATION_KEYS = ['description', 'ui_manufacturer', 'ui_type', 'ui_variation'];

function renameLocKeys(obj, locId) {
  obj['vortex_merged'] = true;
  const locTexts = [];
  LOCALIZATION_KEYS.forEach(key => {
    let locKey = (obj[key] || '').match(/TT:[A-Za-z_.]*/);
    if (locKey !== null) {
      locKey = locKey[0].slice(3);
      // localized
      locTexts.push(locKey);
      obj[key] = `"TT:${locKey}.${locId}"`;
    }
  });
  return locTexts;
}

/**
 * To make liveries for the same aircraft from different mods work we have
 * to merge sections of the aircraft.cfg file
 */
async function mergeAircraft(mergePath, incomingPath, locId, firstMerge) {
  const parser = new IniParser(new WinapiFormat());

  const existingData = await parser.read(mergePath);
  const incomingData = await parser.read(incomingPath);

  const isFLTSIM = section => section.startsWith('FLTSIM.');

  let locTexts = [];

  // update the numbering of FLTSIM sections
  const existingFLTSIM = Object.keys(existingData.data)
    .filter(isFLTSIM)
    .map(key => existingData.data[key]);

  let offset = existingFLTSIM.length;
  const fltsims = {};
  Object.keys(incomingData.data).filter(isFLTSIM).forEach(section => {
    const oldId = section.split('.')[1];
    // don't repeat the base livery and introduce duplicates
    // the latter is particularly relevant since we use one of the mods as the basis for the merge,
    // so we're actually merging that file into itself at some point
    const existingSection = existingFLTSIM.find(iter => _.isEqual(iter, incomingData.data[section]));
    if ((oldId !== '0') && (existingSection === undefined)) {
      locTexts.push(...renameLocKeys(incomingData.data[section], locId));
      fltsims[`FLTSIM.${offset++}`] = incomingData.data[section];
    } else if ((existingSection !== undefined) && existingSection['vortex_merged'] !== true) {
      locTexts.push(...renameLocKeys(incomingData.data[section], locId));
      fltsims[`FLTSIM.${oldId}`] = incomingData.data[section];
    }
    delete incomingData.data[section];
  });

  existingData.data = _.merge(existingData.data, incomingData.data, fltsims);
  await parser.write(mergePath, existingData);

  return locTexts;
}

function isLocPak(fileName) {
  return path.extname(fileName) === '.locPak';
}

async function mergeLocalizations(modPath, mergePath, texts, locId) {
  const locPakNames = (await fs.readdirAsync(modPath)).filter(isLocPak);

  await Promise.all(locPakNames.map(async locPakName => {
    try {
      let locPakIn = JSON.parse(await fs.readFileAsync(path.join(modPath, locPakName)));
      let locPakOut = { LocalisationPackage: {
        Language: locPakIn.LocalisationPackage.Language,
        Strings: {},
      } };

      try {
        // try reading existing locpak, doesn't matter if it's missing
        locPakOut = JSON.parse(await fs.readFileAsync(path.join(mergePath, locPakName)));
      } catch (err) {}

      texts.forEach(textId => {
        locPakOut.LocalisationPackage.Strings[textId + '.' + locId] =
          locPakIn.LocalisationPackage.Strings[textId];
      });

      await fs.writeFileAsync(path.join(mergePath, locPakName),
                              JSON.stringify(locPakOut, undefined, 2));
    } catch (err) {
      log('warn', 'failed to read MSFS locPak', { error: err.message });
    }
  }));

  return locPakNames;
}

function makeMerge(api) {
  return async (filePath, mergePath) => {
    const installPath = selectors.installPathForGame(api.store.getState(), GAME_ID);

    const relPath = path.relative(installPath, filePath).split(path.sep).slice(1).join(path.sep);
    const targetPath = path.join(mergePath, relPath);
    const layoutPath = path.join(mergePath, 'layout.json');

    let layout = { content: [ ] };

    try {
      layout = JSON.parse(await fs.readFileAsync(layoutPath, { encoding: 'utf-8' }));
      firstMerge = false;
    } catch (err) {
      // ignore
    }

    await fs.ensureDirWritableAsync(path.dirname(targetPath), () =>  Promise.resolve());

    try {
      await fs.statAsync(targetPath);
      let locTexts = [];
      const locId = shortid.generate();
      if (path.basename(filePath) === 'aircraft.cfg') {
        const layoutEntry = layout.content.find(iter => iter.path === relPath);
        locTexts = await mergeAircraft(targetPath, filePath, locId);
      }

      // if the configs we merged used localizations, we probably have to merge the corresponding
      // localization files as well, since mods may use the same ids
      if (locTexts.length > 0) {
        const locFiles = await
          mergeLocalizations(path.resolve(filePath, '..', '..', '..', '..'), mergePath, locTexts, locId);
        layout.content = layout.content.filter(iter => !locFiles.includes(iter.path));
        layout.content.push(...(await Promise.all(locFiles.map(async locFileName => {
          const stats = await fs.statAsync(path.join(mergePath, locFileName));
          return {
            path: locFileName,
            size: stats.size,
            date: toWinTimestamp(stats.mtimeMs),
          };
        }))));
      }
    } catch (err) {
      // failed to merge, might be simply the first file we're looking at
      await fs.copyAsync(filePath, targetPath, { noSelfCopy: true });
    }

    try {
      const stats = await fs.statAsync(targetPath);
      layout.content = layout.content.filter(iter => iter.path !== relPath);
      layout.content.push({
        path: relPath,
        size: stats.size,
        date: toWinTimestamp(stats.mtimeMs),
      });
      await fs.writeFileAsync(layoutPath, JSON.stringify(layout, undefined, 2));
    } catch (err) {
      api.showErrorNotification('failed to update layout.json of merge mod', err);
    }
  }
}

function makePrefix(input) {
  let res = '';
  let rest = input;
  while (rest > 0) {
    res = String.fromCharCode(65 + (rest % 25)) + res;
    rest = Math.floor(rest / 25);
  }
  return util.pad(res, 'A', 3);
}

function loadOrderPrefix(api, mod) {
  const state = api.store.getState();
  const profile = selectors.activeProfile(state);
  const loadOrder = util.getSafe(state, ['persistent', 'loadOrder', profile.id], {});
  const pos = loadOrder[mod.id]?.pos ?? -1;
  if (pos === -1) {
    return 'ZZZ-';
  }

  return makePrefix(pos) + '-';
}

function makeModDeployedName(api) {
  return (mod) => {
    if (mod === null) {
      // merge
      return 'ZZZZ-merged-config';
    } else {
      return loadOrderPrefix(api, mod) + mod.id;
    }
  }
}

let tools = [];

let prevLoadOrder;

function main(context) {
  if (process.platform === 'win32') {
    // only supported on windows I guess
    context.registerGame({
      id: GAME_ID,
      name: 'Microsoft Flight Simulator',
      mergeMods: makeModDeployedName(context.api),

      queryPath: findGame,
      supportedTools: tools,
      queryModPath: findModPath,
      requiresLauncher,
      logo: 'gameart.jpg',
      executable: () => EXE_NAME,
      setup,
      requiredFiles: [
        EXE_NAME,
      ],
      environment: {
        SteamAPPId: '1250410',
      },
      details: {
        steamAppId: 1250410,
        stopPatterns: STOP_PATTERNS.map(toWordExp),
      }
    });
  }

  context.registerInstaller('msfs-replacer', 25,
                            testSupportedReplacer, makeInstallReplacer(context.api));

  context.registerMerge(makeTestMerge(context.api), makeMerge(context.api),  '');

  context.registerLoadOrderPage({
    gameId: GAME_ID,
    createInfoPanel: (props) => {
      const t = context.api.translate;
      return t('If you have multiple mods replacing the same content (e.g. engine '
               + 'settings for a plane, in contrast to stuff like liveries that you '
               + 'can select in-game) only the one loaded last here will takge effect.');
    },
    filter: (mods) => mods.filter(mod => (mod.type === '')),
    gameArtURL: `${__dirname}/gameart.jpg`,
    displayCheckboxes: false,
    callback: (loadOrder) => {
      if (!_.isEqual(prevLoadOrder, loadOrder)) {
        context.api.store.dispatch(actions.setDeploymentNecessary(GAME_ID, true))
        prevLoadOrder = loadOrder;
      }
    },
  });

  return true;
}

module.exports = {
  default: main,
  parseOPT
};
