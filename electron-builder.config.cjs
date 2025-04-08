'use strict';

module.exports = {
  appId: 'com.jujharaujla.conduit',
  productName: 'Conduit',
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
    title: 'Conduit ${version}',
    sign: false,
  },
  win: {
    target: ['nsis', 'portable'],
  },
  nsis: {
    artifactName: 'Conduit-${version}-windows-${arch}-setup.${ext}',
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
  },
  portable: {
    artifactName: 'Conduit-${version}-windows-${arch}-portable.${ext}',
  },
};
