'use strict';

module.exports = {
  appId: 'com.jujharaujla.relaybrowser',
  productName: 'Relay Browser',
  directories: {
    output: 'dist',
  },
  files: [
    'src/**/*',
    'package.json',
    'README.md',
  ],
  asar: true,
  npmRebuild: false,
  mac: {
    category: 'public.app-category.productivity',
    target: ['dmg', 'zip'],
  },
  dmg: {
    title: 'Relay Browser ${version}',
    sign: false,
  },
  win: {
    target: ['nsis', 'portable'],
  },
  nsis: {
    artifactName: 'Relay-Browser-${version}-windows-${arch}-setup.${ext}',
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
  },
  portable: {
    artifactName: 'Relay-Browser-${version}-windows-${arch}-portable.${ext}',
  },
};
