function cloud_apply() {

  ADMIN_APP.database().ref("/event_store").on(
    'child_added',
    function(event_snapshot) {

      const event = event_snapshot.val();
      const stream_id = event.stream_id;

      const state_ref = ADMIN_APP.database().ref("/state_store").child(stream_id);

      state_ref.once("value").then(

        function(state_snapshot) {

          /* Mutating the state, because `Object.assign()` only makes a shallow copy.
          */
          const state = state_snapshot.val();
          const state_seq = (state === null) ? 0 : state.seq;

          function check() {
            const event_id = event_snapshot.ref.getKey();
            const action = (event.seq < state_seq) ? "no op" : "replay";
            console.log(`Stream: ${stream_id} event: ${event_id} ${event.event_name}`);
            console.log(`  Action: ${action} (event_seq: ${event.seq}, state_seq: ${state_seq})`);
            if (action === "replay") {
              console.log("^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^\n");
            }
          }

          if ( event.seq < state_seq ) {
            check();
            return;
          } else {

            check();

            function make_event_handler() {

              function sanitize_key(key) {
                return key.split('').map(
                  function(c) {
                    switch (c) {
                      case ".": return "<dot>";
                      case "#": return "<hash>";
                      case "$": return "<dollar>";
                      case "/": return "<forward-slash>";
                      case "[": return "<opening-bracket>";
                      case "]": return "<closing-bracket>";
                      default:  return c;
                    }
                  }).join('');
              }

              var update = {};
              update["seq"] = event.seq;
              update["aggregate"] = event.aggregate;

              /* For list attributes of an aggregate, such as emails,
                 phone numbers, etc.

                 After dropping the "reason" and "from" fields (where included),
                 there should only be one field remaining. (See commands above.)
                 If this is not the case, I messed up. Again.
              */
              function for_list(p) {

                /* The "p" (as in "parameters") object in the factories below it
                  therefore mostly to make pluralization rules explicit:

                        "attribute": The plural name of the attribute in the state.

                        "event_field": The singular event field name for the datum.
                */

                return function(event_snapshot, state) {

                  const event =    event_snapshot.val();
                  const event_id = event_snapshot.ref.getKey();

                  delete event.fields.reason;

                  if ( event.fields.from !== undefined) {

                    update[`${p.attr}/${sanitize_key(event.fields.from)}`] = null;
                    delete event.fields.from;
                  }

                  const key = Object.keys(event.fields)[0];
                  const v   = event["fields"][key];

                  update[`${p.attr}/${sanitize_key(v)}`] = !p.drop ? event_id : null;

                  state_ref.update(update);
                }
              }

              function for_person_name() {

                return function(event_snapshot, state) {

                  const event = event_snapshot.val();

                  delete event.fields.reason
                  update["name"] = event.fields;

                  state_ref.update(update);
                }
              }

              switch (event.event_name) {

                case "person_added":
                case "person_name_changed":
                  return for_person_name();

                case "email_added":
                case "email_updated":
                  return for_list({
                    attr: "emails",
                  });
                case "email_deleted":
                  return for_list({
                    attr: "emails",
                    drop: true
                  });

                case "phone_number_added":
                case "phone_number_updated":
                  return for_list({
                    attr: "phone_numbers",
                  });
                case "phone_number_deleted":
                  return for_list({
                    attr: "phone_numbers",
                    drop: true
                  });

                case "added_to_group":
                  return for_list({
                    attr: "groups",
                  });
                case "removed_from_group":
                  return for_list({
                    attr: "groups",
                    drop: true
                  });

                // case "session_started":
                // case "session_time_updated":
                // case "session_ended":
                //   return for_multi({
                //     attr: "sessions",
                //   });

                // case "recording_added":
                //   return for_multi({
                //     attr: "recordings"
                //   });

                /* No `default` case. If event is not found,
                   I messed something up.
                */
              }
            }

            const update_state = make_event_handler();

            update_state(event_snapshot, state);

          }

        }
      );
    }
  );
}
