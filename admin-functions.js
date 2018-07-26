'use strict'

/* SETUP

   https://medium.com/scientific-breakthrough-of-the-afternoon/sending-password-reset-email-after-user-has-been-created-with-firebase-admin-sdk-node-js-1998a2c6eecf
*/

function init_firebase_admin() {

    const firebase_admin = require('firebase-admin');
    const serviceAccount = require('./access-news-firebase-adminsdk-kvikw-e4024c68e0.json');

    firebase_admin.initializeApp({
        credential: firebase_admin.credential.cert(serviceAccount),
        databaseURL: "https://access-news.firebaseio.com"
    });

    return firebase_admin;
};

const firebase_admin = init_firebase_admin();

function init_firebase_client() {

    const firebase_client = require('firebase');
    const config = require('./firebase_client_config.json');
    firebase_client.initializeApp(config);

    return firebase_client;
};

const firebase_client = init_firebase_client();

/* ADMIN COMMANDS */

/* 0. Helpers */

function store_event(db_ref, name, fields, timestamp, version) {

    /* General structure of events:

       events:(event_name):(auto-id):...fields...:timestamp:version
    */

    Object.assign(
        fields,
        {
            "timestamp": timestamp,
            "version":   version
        }
    );

    const eventObject = {};
    eventObject[name] = fields;

    return db_ref.push(eventObject);
};

/* 1. People */

function add_user(person, account_type) {

    /* `person` object:
       ================
        {
            name: {
                first: "Bala",
                last:  "Bab"
            },
            email: "ema@il.com"
        }

        `account_type`: [ "admin" | "reader" | "listener" ]
    */

    firebase_admin.auth().createUser({ email: person.email }).then(function(userRecord) {

        const db = firebase_admin.database();
        const people_ref = db.ref("events/people");
        const timestamp = firebase_admin.database.ServerValue.TIMESTAMP;

        /* If user creation is successful, save "person_added" event, ... */

        store_event(
            people_ref,
            "person_added",
            {
                "user_id": userRecord.uid,
                "name": {
                    "first": person.name.first,
                    "last":  person.name.last
                }
            },
            timestamp,
            0

        ).then(function(_ref) {

            /* ... save "person_email_added" after above event finishes, and ... */

            store_event(
                people_ref,
                "person_email_added",
                {
                    "user_id": userRecord.uid,
                    "value":   person.email
                },
                timestamp,
                0
            )
        }).then(function(_ref) {

            /* ... finally store the "<account>_added" event. */

            const account_event = account_type + "_added";

            store_event(
                db.ref("events/accounts"),
                account_event,
                {
                    "user_id":  userRecord.uid,
                    "username": person.email
                },
                timestamp,
                0
            );
        }).catch(function(error) { console.log(error) });

        firebase_client.auth().sendPasswordResetEmail(person.email);
    });
};

module.exports = {
    firebase_admin,
    firebase_client,
    store_event,
    add_user
};
