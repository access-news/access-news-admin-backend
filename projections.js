'use strict'

const f = require('./firebase_apps.js');
const db = f.ADMIN_APP.database();

function desanitize_email(key) {

  const subs = key.match(/<.+?>/g);
  var email = key;

  for (s in subs) {

    const sub = subs[s];

    switch (sub) {
      case "<dot>":
        email = email.replace(sub, '.');
        break;
      case "<hash>":
        email = email.replace(sub, '#');
        break;
      case "<dollar>":
        email = email.replace(sub, '$');
        break;
      case "<forward-slash>":
        email = email.replace(sub, '/');
        break;
      case "<opening-bracket>":
        email = email.replace(sub, '[');
        break;
      case "<closing-bracket>":
        email = email.replace(sub, ']');
        break;
    }
  }
  return email;
}

function rebuild_projections() {

  /* Responsible for 2 projections:
     uid -> date -> recordings
     date -> recordings
  */
  function set_by_datetime(stream, into, aggregate, properties) {

    // const uid = stream.user_id;
    const timestamp = Object.values(stream._meta.event_ids).pop();
    const datetimeStrings = new Date(timestamp).toISOString().split(/[T.]/).slice(0,2);

    const update = {};
    update[datetimeStrings[1]] = properties.reduce(
      function(acc, prop) {
        acc[prop] = stream[prop];
        return acc;
      }, {}
    );

    // if (into[aggregate][uid] === undefined) {
    //   into[aggregate][uid] = {};
    // }

    if (into[aggregate][datetimeStrings[0]] === undefined) {
      into[aggregate][datetimeStrings[0]] = {};
    }

    Object.assign(into[aggregate][datetimeStrings[0]], update);
  }

  /* Responsible for 2 projections:
     uid -> publications -> articles
     publications -> articles
  */
  function set_by_reader_and_publication(stream, into, aggregate, properties) {

    const uid = stream.user_id;
    const pub = stream.publication;
    const timestamp = Object.values(stream._meta.event_ids).pop();
    const datetimeStrings = new Date(timestamp).toISOString().split(/[T.]/).slice(0,2).join(' ');

    const update = {};
    update[stream.stream_id] = properties.reduce(
      function(acc, prop) {
        acc[prop] = stream[prop];
        return acc;
      }, {}
    );
    update[stream.stream_id]['date'] = datetimeStrings;

    if (into[aggregate][uid] === undefined) {
      into[aggregate][uid] = {};
    }

    if (into[aggregate][uid][pub] === undefined) {
      into[aggregate][uid][pub] = {};
    }

    Object.assign(into[aggregate][uid][pub], update);
  }

  db.ref('/state_store').once('value').then(
    function(state_store_snapshot) {

      const state_store = state_store_snapshot.val();

      var projections = {
        'people': {},
        'readers': {},
        'listeners': {},
        'admins': {},
        'recordings_by_time': {},
        'recordings_by_publication': {},
        'sessions': {},
      }

      Object.keys(state_store).forEach(

        function(stream_id) {

          const stream = state_store[stream_id];
          stream["stream_id"] = stream_id;

          switch (stream["_meta"]["aggregate"]) {

            case 'person':
              delete stream._meta;

              Object.assign(stream, stream.name);
              delete stream.name;

              projections['people'][stream_id] = stream;

              Object.keys(stream.groups).forEach(
                function(g) {
                  projections[g][stream_id] = stream;
                }
              );
              break;

            case 'session':
              set_by_datetime(stream, projections, 'sessions', ['seconds']);

              projections['people'][stream.user_id]['sessions'] = projections['sessions'][stream.user_id];
              break;

            case 'recording':
              set_by_datetime(stream, projections, 'recordings_by_time', ['duration', 'filename', 'publication']);
              set_by_reader_publication(stream, projections, 'recordings_by_publication', ['duration', 'filename']);

              projections['people'][stream.user_id]['recordings'] = projections['recordings_by_publication'][stream.user_id];
              break;

            default:
              console.log('parabola of mystery');
          }
        }
      )

      db.ref().child("/projections").update(projections);
    }
  )
}

function readers() {

  db.ref("/state_store").on(
    'child_added',
    function(child_snapshot) {

    }
  )
}

module.exports = {
  rebuild_projections,
};
