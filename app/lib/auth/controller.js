const fs = require('graceful-fs');
const path = require('path');

const {session} = require('electron');

const OidcCtrl = require('../../ui/oidc/controller.js');
const StartupCtrl = require('../../ui/startup/controller.js');
const OauthCtrl = require('../../ui/oauth/controller.js');
const logger = require('../logger.js');
const fsUtility = require('../fs-utility.js');
const syncFactory = require('@gyselroth/balloon-node-sync');

var syncArchiveSatesFactory = function(clientConfig) {
  var states;
  var statesFile;
  var archiveDir;

  function initialize(clientConfig) {
    archiveDir = path.join(clientConfig.get('configDir'), 'syncStatesArchive');
    statesFile = path.join(archiveDir, 'states.json');


    if(!fs.existsSync(archiveDir)) {
      fs.mkdirSync(archiveDir);
    }

    if(!fs.existsSync(statesFile)) {
      states = {};
    } else {
      states = require(statesFile);
    }

    persist();
  }

  function persist() {
    if(fs.existsSync(statesFile)) {
      fs.truncateSync(statesFile, 0);
    }

    fs.writeFileSync(statesFile, JSON.stringify(states, null, 2));
  }

  initialize(clientConfig);

  return {
    getArchiveDir: function() {
      return archiveDir
    },
    get: function(key) {
      return states[key];
    },
    set: function(key, value) {
      states[key] = value;
      persist();
    }
  }
}

module.exports = function(env, clientConfig) {
  //TODO oauth deprecated, remove after oidc migration
  var oauth = OauthCtrl(env, clientConfig);
  var oidc = OidcCtrl(env, clientConfig);

  function isLoggedIn() {
    return clientConfig.get('loggedin')
  }

  function logout() {
    logger.info('AUTH: logout initialized');

    return new Promise(function(resolve, reject) {
      clientConfig.destroySecret(clientConfig.getSecretType()).then(() => {
        clientConfig.setMulti({
          'loggedin': false,
          'auth': undefined,
          'disableAutoAuth': false
        });

        resolve();
      }).catch((error) => {
        logger.error("failed to destroy secret, but user gets logged out anyways", {error})
        clientConfig.setMulti({
          'loggedin': false,
          'auth': undefined,
          'disableAutoAuth': false
        });

        resolve();
      })

      //TODO raffis - logout needs to be reviewd after oauth gets removed (oidc replacement)
      //TODO raffis - https://github.com/openid/AppAuth-JS/issues/17
      //AppAuth doesnt fetch the revoke endpoint from the discovery, maybe fork&fix
    });
  }
  
  function basicAuth(username, password) {
    var oldUser = clientConfig.get('username');
    clientConfig.set('auth', 'basic');
    
    return new Promise(function(resolve, reject){
      clientConfig.storeSecret('password', password).then(() => {
        verifyNewLogin(oldUser, username).then((username) => {
          //clientConfig.set('username', username);
          if(oldUser === undefined || oldUser !== username) {
            resolve(username); 
          } else {
            resolve();
          }
        }).catch((err) => {
          reject(err)
        });
      }).catch((err) => {
        reject(err)
      });
    });
  } 

  function oidcAuth(idpConfig) {
    return new Promise(function(resolve, reject) {
      var oldUser = clientConfig.get('username');
      //TODO raffis - backwards compatibility, gets removed soon
      if(idpConfig.responseType === 'token') {
        return oauth.signin(idpConfig).then(() => {
          verifyNewLogin(oldUser).then((username) => {
            //clientConfig.set('username', username);
            if(oldUser === undefined || oldUser !== username) {
              resolve(username); 
            } else {
              resolve();
            }
          });
        }).catch((error) => {
          reject(error);
        });
      }
    
      oidc.signin(idpConfig).then((authorization) => {
        if(authorization === true)  {
          verifyNewLogin(oldUser).then((username) => {
            //clientConfig.set('username', username);
            if(oldUser === undefined || oldUser !== username) {
              resolve(username); 
            } else {
              resolve();
            }
          }).catch((error) => {
            reject(error)
          });
        } else {
          resolve();
        }
      });
    });
  } 
  
  function retrieveLoginSecret() {
    return new Promise(function(resolve) {
      if(!clientConfig.get('auth')) {
        logger.info('AUTH: no authentication method set yet');
        return resolve();
      }

      clientConfig.retrieveSecret(clientConfig.getSecretType()).then((secret) => {
        clientConfig.setSecret(secret)
        resolve();
      }).catch((error) => {
        logger.error('AUTH: failed retrieve secret from keystore', {error});
        resolve();
      })
    });
  }

  function login(startup) {
    logger.info('AUTH: login initialized');
    var oldUser = clientConfig.get('username');

    return new Promise(function (resolve, reject) {
      verifyAuthentication().then(() => {
        return resolve();  
      }).catch((err) => {
        if(clientConfig.get('auth') === 'oidc') {
          var oidcProvider = clientConfig.get('oidcProvider');
          if(oidcProvider === undefined) {
            startup().then(() => {
              resolve();
            });
          } else {
            var idpConfig = getIdPByName(oidcProvider);
            startup().then(() => {
              resolve();
            });
          }
        } else {
          startup().then(() => {
            resolve();
          });
        }
      });
    });
  }     
 
  function getIdPByName(name) {
    for(var i=0; i<env.auth.oidc.length; i++) {
      if(env.auth.oidc[i].provider === name) {
        return env.auth.oidc[i];
      }
    }

    return undefined;
  }

  function verifyAuthentication() {
    return new Promise(function(resolve, reject) {
      var sync = syncFactory(clientConfig.getAll(true), logger);
      sync.blnApi.whoami(function(err, username) {
        if(err) {
          clientConfig.set('loggedin', false);
          reject(err);
        } else {
          clientConfig.set('loggedin', true);
          resolve();
        }
      });
    });
  }

  function verifyNewLogin(oldUser, newUser) {
    return new Promise(function(resolve, reject) {
      var config = clientConfig.getAll(true);
      config.username = newUser;      

      var sync = syncFactory(config, logger);
      sync.blnApi.whoami(function(err, username) {
        if(err) {
          logger.error('failed verify authentication', {err});
          clientConfig.set('oidcProvider', undefined);
          //clientConfig.set('username', undefined);
          return reject(err);
        }
 
        logger.info('successfully verified authentication', {username});
        clientConfig.set('loggedin', true);

        if(oldUser !== undefined && username !== undefined && username !== oldUser) {
          logger.info('AUTH: a new user logged in switching sync state', {oldUser, username});
          clientConfig.set('username', username);

          switchSyncState(oldUser, username).then(() => {
            resolve(username);
          }).catch((err) => {
            logger.error('AUTH: switching sync state had an error', {err});

            logout().then(function() {
              clientConfig.set('username', oldUser);
              clientConfig.set('loggedin', false);
              reject(err);
            }).catch(err => {
              clientConfig.setMulti({
                'username': oldUser,
                'loggedin': false
              });
              reject(err);
            });
          });
        } else {
          resolve(username);
        }
      });
    });
  }
    
  function switchSyncState(oldUser, currentUser) {
    var syncArchiveStates = syncArchiveSatesFactory(clientConfig);

    return new Promise(function(resolve, reject) {
      archiveCurrentState(oldUser).then(() => {
        initializeSyncState(currentUser, resolve, reject);
      }).catch(reject);
    });

    function archiveCurrentState(username) {
      return new Promise(function(resolve, reject) {
        Promise.all([
          archiveBalloonDir(username),
          archiveSyncState(username)
        ]).then((results) => {
          var balloonDirPath = results[0];
          var syncStatePath = results[1];
          var balloonDirIno = fs.lstatSync(balloonDirPath).ino;
          var syncStateIno = fs.lstatSync(syncStatePath).ino;

          syncArchiveStates.set(username, {
            balloonDirPath,
            balloonDirIno,
            syncStatePath,
            syncStateIno
          });

          resolve(results);
        }).catch(function(err) {
          reject(err);
        });
      });
    }

    function archiveBalloonDir(username) {
      return new Promise(function(resolve, reject) {
        logger.info('AUTH: archiveBalloonDir initialized', {username});

        var homeDir = process.env[(/^win/.test(process.platform)) ? 'USERPROFILE' : 'HOME'];
        var balloonDirsyncStateArchivePath;
        var versionNumber = 0;
        var versionString = '';

        while(true) {
          if(versionNumber > 0) versionString = '-' + versionNumber;

          var balloonDirsyncStateArchivePath = path.join(homeDir, 'BalloonDir-' + username + versionString);

          if(!fs.existsSync(balloonDirsyncStateArchivePath)) break;

          versionNumber++;
        }

        fs.rename(clientConfig.get('balloonDir'), balloonDirsyncStateArchivePath, (err) => {
          if(err) return reject(err);

          logger.info('AUTH: archiveBalloonDir finished', {balloonDirsyncStateArchivePath});
          resolve(balloonDirsyncStateArchivePath);
        });
      });
    }

    function archiveSyncState(username) {
      logger.info('AUTH: archiveSyncState initialized', {username});

      return new Promise(function(resolve, reject) {
        var syncStateArchiveDirPath = syncArchiveStates.getArchiveDir();

        var syncStateArchivePath;
        var versionNumber = 0;
        var versionString = '';

        while(true) {
          if(versionNumber > 0) versionString = '-' + versionNumber;

          syncStateArchivePath = path.join(syncStateArchiveDirPath, username + versionString);
          if(!fs.existsSync(syncStateArchivePath)) break;

          versionNumber++;
        }

        try {
          fs.mkdirSync(syncStateArchivePath);
        } catch(err) {
          reject(err);
        }

        Promise.all([
          new Promise(function(resolve, reject) {
            var newDbPath = path.join(syncStateArchivePath, 'db');
            var oldDbPath = path.join(clientConfig.get('configDir'), 'db');

            if(fs.existsSync(oldDbPath) === false) return resolve();

            fs.rename(oldDbPath, newDbPath, (err) => {
              if(err) return reject(err);

              resolve();
            });
          }),
          new Promise(function(resolve, reject) {
            var newCursorPath = path.join(syncStateArchivePath, 'last-cursor');
            var oldCursorPath = path.join(clientConfig.get('configDir'), 'last-cursor');

            if(fs.existsSync(oldCursorPath) === false) return resolve();

            fs.rename(oldCursorPath, newCursorPath, (err) => {
              if(err) return reject(err);

              resolve();
            });
          })
        ]).then(function() {
          logger.info('AUTH: archiveSyncState finished', {syncStateArchivePath});

          resolve(syncStateArchivePath);
        }).catch((err) => {
          logger.error('AUTH: archiveSyncState failed', {err});

          reject(err);
        });
      });
    }

    function initializeSyncState(username, resolve, reject) {
      logger.info('AUTH: initializeSyncState initialized', {username});
      var existingState = syncArchiveStates.get(username);

      if(existingState && fs.existsSync(existingState.balloonDirPath) && fs.existsSync(existingState.syncStatePath)) {
        Promise.all([
          unarchiveBalloonDir(existingState),
          unarchiveSyncDb(existingState),
          unarchiveLastCursor(existingState)
        ]).then(() => {
          var syncStatePath = existingState.syncStatePath;

          syncArchiveStates.set(username, undefined);

          fsUtility.rmdirp(syncStatePath, err => {
            resolve();
          });
        }).catch(reject);
      } else {
        createBalloonDir(resolve, reject);
      }
    }

    function createBalloonDir(resolve, reject) {
      fsUtility.createBalloonDir(clientConfig.get('balloonDir'), (err) => {
        if(err) return reject(err);

        logger.info('AUTH: initializeSyncState finished');

        resolve();
      });
    }

    function unarchiveBalloonDir(existingState) {
      logger.info('AUTH: unarchiveBalloonDir initialized', {existingState});

      return new Promise(function(resolve, reject) {
        if(fs.existsSync(existingState.balloonDirPath) === false) return createBalloonDir(resolve, reject);

        fs.rename(existingState.balloonDirPath, clientConfig.get('balloonDir'), (err) => {
          if(err) return reject(err);

          logger.info('AUTH: unarchiveBalloonDir finished', {balloonDir: clientConfig.get('balloonDir')});

          resolve();
        });
      });
    }

    function unarchiveSyncDb(existingState) {
      logger.info('AUTH: unarchiveSyncDb initialized', {existingState});

      return new Promise(function(resolve, reject) {
        var srcPath = path.join(existingState.syncStatePath, 'db');
        var targetPath = path.join(clientConfig.get('configDir'), 'db');

        if(fs.existsSync(srcPath) === false) {
          fsUtility.mkdirp(targetPath);
        } else {
          fs.rename(srcPath, targetPath, (err) => {
            if(err) return reject(err);

            logger.info('AUTH: unarchiveSyncDb finished', {targetPath});

            resolve();
          });
        }
      });
    }

    function unarchiveLastCursor(existingState) {
      logger.info('AUTH: unarchiveLastCursor initialized', {existingState});

      return new Promise(function(resolve, reject) {
        var srcPath = path.join(existingState.syncStatePath, 'last-cursor');
        var targetPath = path.join(clientConfig.get('configDir'), 'last-cursor');

        if(fs.existsSync(srcPath) === false) return resolve();

        fs.rename(srcPath, targetPath, (err) => {
          if(err) return reject(err);

          logger.info('AUTH: unarchiveLastCursor finished', {targetPath});

          resolve();
        });
      });
    }
  }

  return {
    logout,
    login,
    isLoggedIn,
    basicAuth,
    oidcAuth, 
    getIdPByName,
    retrieveLoginSecret,
  }
}
