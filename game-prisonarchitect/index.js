const Promise = require('bluebird');
const path = require('path');
const winapi = require('winapi-bindings');
const { fs, util } = require('vortex-api');
const { app, remote } = require('electron');

const executable =  process.platform == 'linux'
    ? 'PrisonArchitect'
    : 'Prison Architect64.exe';

const appUni = remote !== undefined ? remote.app : app;

const GAME_ID = 'prisonarchitect';
const STEAM_ID = 233450;
const STEAM_DLL = 'steam_api64.dll';

function modPath() {
  if (process.platform == 'linux') {
    return path.join(appUni.getPath('home'), '.Prison Architect', 'mods');
  } else {
    return path.resolve(appUni.getPath('appData'), '..', 'Local', 'Introversion', 'Prison Architect', 'mods');
  }
}

function requiresLauncher(gamePath) {
  return fs.readdirAsync(gamePath)
    .then(files => (files.find(file => file.endsWith(STEAM_DLL)) !== undefined)
      ? Promise.resolve({ launcher: 'steam' })
      : Promise.resolve(undefined))
    .catch(err => Promise.reject(err));
}

function findGame() {
  try {
    const instPath = winapi.RegGetValue(
      'HKEY_LOCAL_MACHINE',
      'SOFTWARE\\Introversion Software\\Prison Architect',
      'Install Dir');
    if (!instPath) {
      throw new Error('empty registry key');
    }
    return Promise.resolve(instPath.value);
  } catch (err) {
    return util.steam.findByAppId(STEAM_ID.toString())
      .then(game => game.gamePath);
  }
}

function setup(discovery) {
  return fs.ensureDirWritableAsync(modPath(), () => Promise.resolve());
}

function main(context) {
  context.registerGame(
    {
      id: GAME_ID,
      name: 'Prison Architect',
      logo: 'gameart.jpg',
      mergeMods: true,
      queryPath: findGame,
      queryModPath: () => modPath(),
      //requiresLauncher,
      executable: () => executable,
      requiredFiles: [executable],
      environment: {
        SteamAPPId: STEAM_ID.toString(),
      },
      details:
      {
        steamAppId: STEAM_ID,
      },
      setup,
    });

  return true;
}

module.exports = {
    default: main
};
