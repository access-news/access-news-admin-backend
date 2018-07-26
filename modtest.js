'use strict';

function lofa() { console.log(27); }

function vmi() { console.log(fa().database.ServerValue.TIMESTAMP); }

const balabab = fa();

function fa() {

    const firebase_admin = require('firebase-admin');
    const serviceAccount = require('./access-news-firebase-adminsdk-kvikw-e4024c68e0.json');

    firebase_admin.initializeApp({
        credential: firebase_admin.credential.cert(serviceAccount),
        databaseURL: "https://access-news.firebaseio.com"
    });

    return firebase_admin;
};

module.exports = {
    lofa,
    vmi,
    fa,
    balabab
};

// exports.initFirebaseClient = function () {

//     const firebase_client = require('firebase');

//     var config = {
//         apiKey: "AIzaSyCk9-LMebD0O4l6Zc8xv773yDslgojt8j8",
//         authDomain: "access-news.firebaseapp.com",
//         databaseURL: "https://access-news.firebaseio.com",
//         projectId: "access-news",
//         storageBucket: "access-news.appspot.com",
//         messagingSenderId: "32911745165"
//     };

//     firebase_client.initializeApp(config);
// };
