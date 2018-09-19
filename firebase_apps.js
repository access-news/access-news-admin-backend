'use strict'

function admin() {

  const firebase_admin = require('firebase-admin');
  const serviceAccount = require('./access-news-firebase-adminsdk-kvikw-e4024c68e0.json');

  firebase_admin.initializeApp({
    credential: firebase_admin.credential.cert(serviceAccount),
    databaseURL: "https://access-news.firebaseio.com"
  });

  return firebase_admin;
};

const ADMIN_APP = admin();

function client() {

  const firebase_client = require('firebase');
  const config = require('./firebase_client_config.json');
  firebase_client.initializeApp(config);

  return firebase_client;
};

const CLIENT_APP = client();

module.exports = {
  ADMIN_APP,
  CLIENT_APP
};
