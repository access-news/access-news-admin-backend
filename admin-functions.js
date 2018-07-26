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

function store_stream_event(fire_app, fields, version, seq) {

    /* General structure of events:

       event_store/stream_id/event_id/event/...fields.../timestamp/version/seq

       stream_id: unique identifier of the aggregate instance (such as user_id,
                  category_id etc.). Basically an entity that should have its
                  own identity in the system.

                  For example, categories and publications have their own streams,
                  as we need to track them, even if a publication has no content
                  (i.e., recordings) yet. Groups on the other hand are tracked
                  with a person's stream because they always have users, and
                  introducing a new group should have a purpose, and therefore
                  initial users.
        seq: "expected_version" in other event store implementations, but I
             think that name is misleading, especially if one tries to version
             their events. It is a sequential number for every event in the
             stream that, denoting chronological sequence.

             Calling the function with seq=0 implies the start of a new stream.
    */

    Object.assign(
        fields,
        {
            "timestamp": fire_app.database.ServerValue.TIMESTAMP,
            "version":   version,
            "seq":       seq
        }
    );

    return fire_app.database().ref("event_store").push(fields);
};

/* 1. People */

function add_person(name, fire_app) {

    /* nameObject: {
            first: "Bala",
            last:  "Bab"
        },

       fire_app: Firebase app instance (admin, client, etc.)
    */

    /* Start a new PEOPLE stream, returning a Firebase Realtime DB
       promise, that can be chained. */
    return store_event(fire_app, nameObject, 0, 0);

}
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
        const people_ref = db.ref("event_store");
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
                db.ref("event_store"),
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
