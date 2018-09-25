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

  db.ref('/state_store').once('value').then(
    function(state_store_snapshot) {

      const state_store = state_store_snapshot.val();
      var update = {};

      Object.keys(state_store).forEach(

        function(stream_id) {

          const stream = state_store[stream_id];
          stream["stream_id"] = stream_id;

          const aggregate = stream["_meta"]["aggregate"];
          const user_id = (aggregate === 'person') ? stream_id : stream.user_id;

          const t = (function timestamps(stream) {

            const event_ids = Object.keys(stream._meta.event_ids);
            const oldest_key = event_ids[0];
            const newest_key = event_ids[event_ids.length-1];

            const [created_at, updated_at] = [
              stream._meta.event_ids[ oldest_key ],
              stream._meta.event_ids[ newest_key ]
            ].map(
              function(timestamp) {
                return new Date(timestamp).toISOString().split(/[T.Z]/).slice(0,3);
              }
            );

            return {
              'created_at': {
                'date': created_at[0],
                'time': created_at[1],
                'ms':   created_at[2]
              },
              'updated_at': {
                'date': updated_at[0],
                'time': updated_at[1],
                'ms':   updated_at[2]
              }
            };
          })(stream);

          (function put_timestamps_into_stream(stream) {
            stream["_created_at"] = `${t.created_at.date}-${t.created_at.time}:${t.created_at.ms}`;
            stream["_updated_at"] = `${t.updated_at.date}-${t.updated_at.time}:${t.created_at.ms}`;
          })(stream);

          delete stream._meta;

          switch (aggregate) {

            case 'person':
              if (!update['people']) { update['people'] = {} }
              update['people'][user_id] = stream;
              break;

            case 'session':
              if (!update['sessions']) { update['sessions'] = {} }

              if (!update['sessions']['by_stream']) { update['sessions']['by_stream'] = {} }
              // update:
              update['sessions']['by_stream'][stream_id] = stream;

              if (!update['people']) { update['people'] = {} }
              if (!update['people'][user_id]) { update['people'][user_id] = {} }
              if (!update['people'][user_id]['sessions']) { update['people'][user_id]['sessions'] = {} }
              update['people'][user_id]['sessions'][stream_id] = stream;
              break;

            case 'recording':
              if (!update['recordings']) { update['recordings'] = {} }
              if (!update['recordings']['by_stream']) { update['recordings']['by_stream'] = {} }
              update['recordings']['by_stream'][stream_id] = stream;

              if (!update['people']) { update['people'] = {} }
              if (!update['people'][user_id]) { update['people'][user_id] = {} }
              if (!update['people'][user_id]['recordings']) { update['people'][user_id]['recordings'] = {} }
              update['people'][user_id]['recordings'][stream_id] = stream;
              break;

            default:
              console.error(`No case for ${aggregate} aggregate`);
          }
        }
      )

      db.ref().child("/projections").update(update);
    }
  )
}

module.exports = {
  rebuild_projections,
};
