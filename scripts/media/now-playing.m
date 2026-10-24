// macOS: what the system's "Now Playing" app is (Spotify, Music, a video in a
// browser tab), and pausing or resuming it. Built by scripts/media.mjs into a
// small library and run through /usr/bin/perl: since macOS 15.4 only Apple's
// own programs may ask MediaRemote what is playing, and the system Perl is
// one of them.
//
// MR_ACTION=pause   pause the Now Playing app if it is playing
// MR_ACTION=resume  play it if it is not playing
// Either only if the Now Playing app is still MR_PID (when given): the user
// may have moved on to another app.
// Anything else only reports. Prints {"pid":…,"playing":…,"sent":…}, where
// `playing` is the state found and `sent` that the player acted on the command.

#import <Foundation/Foundation.h>
#include <dlfcn.h>

typedef void (*IsPlayingFn)(dispatch_queue_t, void (^)(Boolean));
typedef void (*PidFn)(dispatch_queue_t, void (^)(int));
typedef Boolean (*SendFn)(int, NSDictionary *);

enum { COMMAND_PLAY = 0, COMMAND_PAUSE = 1 };

// Called by Perl as an XSUB; the Perl arguments are not used. Exits the
// process when done, so nothing is handed back to Perl.
void run(void *perl, void *cv) {
  void *framework = dlopen("/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote", RTLD_NOW);
  IsPlayingFn isPlaying = (IsPlayingFn)dlsym(framework, "MRMediaRemoteGetNowPlayingApplicationIsPlaying");
  PidFn nowPlayingPid = (PidFn)dlsym(framework, "MRMediaRemoteGetNowPlayingApplicationPID");
  SendFn send = (SendFn)dlsym(framework, "MRMediaRemoteSendCommand");
  if (!isPlaying || !nowPlayingPid || !send) {
    printf("{\"error\":\"MediaRemote unavailable\"}\n");
    exit(1);
  }

  dispatch_queue_t queue = dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0);
  __block int pid = 0;
  dispatch_semaphore_t gotPid = dispatch_semaphore_create(0);
  nowPlayingPid(queue, ^(int p) {
    pid = p;
    dispatch_semaphore_signal(gotPid);
  });
  dispatch_semaphore_wait(gotPid, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
  Boolean (^readPlaying)(void) = ^Boolean {
    __block Boolean playing = false;
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    isPlaying(queue, ^(Boolean p) {
      playing = p;
      dispatch_semaphore_signal(done);
    });
    dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
    return playing;
  };
  Boolean playing = readPlaying();

  const char *action = getenv("MR_ACTION");
  const char *expected = getenv("MR_PID");
  Boolean same = pid > 0 && (!expected || atoi(expected) == pid);
  int command = -1;
  if (action && strcmp(action, "pause") == 0 && same && playing) command = COMMAND_PAUSE;
  if (action && strcmp(action, "resume") == 0 && same && !playing) command = COMMAND_PLAY;
  Boolean sent = false;
  if (command >= 0 && send(command, nil)) {
    // The command is delivered asynchronously: wait (up to a second) until the
    // player has acted on it, so it is not lost when this process exits.
    Boolean want = command == COMMAND_PLAY;
    for (int i = 0; i < 20 && !sent; i++) {
      usleep(50 * 1000);
      sent = readPlaying() == want;
    }
  }
  printf("{\"pid\":%d,\"playing\":%s,\"sent\":%s}\n", pid, playing ? "true" : "false", sent ? "true" : "false");
  fflush(stdout);
  exit(0);
}
