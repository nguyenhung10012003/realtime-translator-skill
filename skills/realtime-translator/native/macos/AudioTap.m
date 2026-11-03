// audio-tap — macOS per-process audio capture helper.
//
// A tiny binary spawned by the Node CLI (src/audio/sources/MacosTapSource.ts):
//
//   audio-tap list
//     Prints a JSON array of processes known to Core Audio (pid, name,
//     bundleId, audioActive) and exits.
//
//   audio-tap tap <pid>
//     Creates a Core Audio process tap (macOS 14.4+) for the given pid — a
//     mono mixdown of everything that process plays — wires it into a private
//     aggregate device, prints ONE header line describing the stream
//     ("AUDIO-TAP 1 rate=48000 channels=1 format=f32") and then streams raw
//     little-endian PCM to stdout until it receives SIGTERM/SIGINT.
//
// Exit codes (mapped to user-facing messages on the Node side):
//   0 clean · 64 usage · 66 target process unknown to Core Audio ·
//   69 needs macOS 14.4+ · 70 internal Core Audio error · 77 permission denied
//
// The first tap creation triggers the TCC "System Audio Recording" prompt for
// the *responsible* app (the terminal or agent host that launched the CLI) — a denial
// surfaces here as a tap-creation failure, reported as exit 77.
//
// Written in Objective-C (not Swift) on purpose: it needs nothing Swift offers
// and clang compiles it against any SDK without Swift-toolchain coupling.

#import <AppKit/AppKit.h>
#import <CoreAudio/AudioHardware.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#import <Foundation/Foundation.h>
#include <fcntl.h>
#include <libproc.h>
#include <signal.h>
#include <unistd.h>

static void failWith(int code, NSString *message) {
  fprintf(stderr, "%s\n", message.UTF8String);
  exit(code);
}

static AudioObjectPropertyAddress addressFor(AudioObjectPropertySelector selector) {
  return (AudioObjectPropertyAddress){
      selector, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
}

// MARK: - Property helpers

static BOOL getPodProperty(AudioObjectID objectID, AudioObjectPropertySelector selector,
                           void *out, UInt32 size) {
  AudioObjectPropertyAddress address = addressFor(selector);
  UInt32 ioSize = size;
  return AudioObjectGetPropertyData(objectID, &address, 0, NULL, &ioSize, out) == noErr;
}

static NSString *_Nullable getStringProperty(AudioObjectID objectID,
                                             AudioObjectPropertySelector selector) {
  AudioObjectPropertyAddress address = addressFor(selector);
  CFStringRef value = NULL;
  UInt32 size = sizeof(value);
  if (AudioObjectGetPropertyData(objectID, &address, 0, NULL, &size, &value) != noErr ||
      value == NULL) {
    return nil;
  }
  return (__bridge_transfer NSString *)value;
}

static NSArray<NSNumber *> *processObjectList(void) {
  AudioObjectPropertyAddress address = addressFor(kAudioHardwarePropertyProcessObjectList);
  UInt32 dataSize = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, NULL, &dataSize) !=
      noErr) {
    return @[];
  }
  UInt32 count = dataSize / sizeof(AudioObjectID);
  AudioObjectID *list = calloc(count, sizeof(AudioObjectID));
  if (list == NULL) return @[];
  NSMutableArray<NSNumber *> *result = [NSMutableArray arrayWithCapacity:count];
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &dataSize, list) ==
      noErr) {
    for (UInt32 i = 0; i < dataSize / sizeof(AudioObjectID); i++) {
      [result addObject:@(list[i])];
    }
  }
  free(list);
  return result;
}

static AudioObjectID processObjectForPID(pid_t pid) {
  AudioObjectPropertyAddress address =
      addressFor(kAudioHardwarePropertyTranslatePIDToProcessObject);
  AudioObjectID objectID = kAudioObjectUnknown;
  UInt32 size = sizeof(objectID);
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, sizeof(pid), &pid, &size,
                                 &objectID) != noErr) {
    return kAudioObjectUnknown;
  }
  return objectID;
}

// MARK: - list mode

static void runList(void) {
  // Never offer our own app for capture — tapping ourselves (the translated
  // voice we may be playing) is the textbook feedback loop.
  NSString *ownBundle =
      [NSRunningApplication runningApplicationWithProcessIdentifier:getppid()].bundleIdentifier;

  NSMutableArray<NSDictionary *> *entries = [NSMutableArray array];
  NSMutableSet<NSNumber *> *seenPids = [NSMutableSet set];
  for (NSNumber *objectNumber in processObjectList()) {
    AudioObjectID objectID = objectNumber.unsignedIntValue;
    pid_t pid = 0;
    if (!getPodProperty(objectID, kAudioProcessPropertyPID, &pid, sizeof(pid))) continue;
    if (pid == getpid() || pid == getppid()) continue;
    if ([seenPids containsObject:@(pid)]) continue;

    NSString *bundleId = getStringProperty(objectID, kAudioProcessPropertyBundleID);
    if (bundleId.length == 0) bundleId = nil;
    // Exclude our own app AND its helper processes — Chromium plays audio from a
    // helper whose bundle id is our bundle id + ".helper…" (e.g.
    // com.example.app.helper), and offering that as a capture target is the
    // textbook feedback loop (we'd re-capture the translated voice we play).
    if (bundleId != nil && ownBundle != nil &&
        ([bundleId isEqualToString:ownBundle] ||
         [bundleId hasPrefix:[ownBundle stringByAppendingString:@"."]])) {
      continue;
    }

    // Audio often plays from an app's helper process (Chromium renderers…),
    // which AppKit doesn't consider a "running application" — fall back to the
    // kernel's process name before giving up to a bare pid.
    NSRunningApplication *app =
        [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    NSString *name = app.localizedName;
    if (name.length == 0) {
      char procName[2 * MAXCOMLEN] = {0};
      if (proc_name(pid, procName, sizeof(procName)) > 0) name = @(procName);
    }
    if (name.length == 0) name = bundleId;
    if (name.length == 0) name = [NSString stringWithFormat:@"PID %d", pid];

    UInt32 runningOutput = 0;
    getPodProperty(objectID, kAudioProcessPropertyIsRunningOutput, &runningOutput,
                   sizeof(runningOutput));

    // Apple system daemons show up in the process list but are useless capture
    // targets while idle — let the UI hide them unless they're playing audio.
    BOOL isSystem = (app == nil && [bundleId hasPrefix:@"com.apple."]);

    [seenPids addObject:@(pid)];
    [entries addObject:@{
      @"pid" : @(pid),
      @"name" : name,
      @"bundleId" : bundleId ?: [NSNull null],
      @"audioActive" : @(runningOutput != 0),
      @"system" : @(isSystem),
    }];
  }

  // Currently-playing apps first, then alphabetical.
  [entries sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
    BOOL activeA = [a[@"audioActive"] boolValue], activeB = [b[@"audioActive"] boolValue];
    if (activeA != activeB) return activeA ? NSOrderedAscending : NSOrderedDescending;
    return [a[@"name"] localizedCaseInsensitiveCompare:b[@"name"]];
  }];

  NSError *error = nil;
  NSData *json = [NSJSONSerialization dataWithJSONObject:entries options:0 error:&error];
  if (json == nil) failWith(70, @"JSON encoding failed");
  fwrite(json.bytes, 1, json.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
  exit(0);
}

// MARK: - tap mode

static pid_t gTargetPID = 0;
/** Whether the tapped app's own output is currently silenced (dub-over mode). */
static BOOL gMuted = NO;
static AudioObjectID gTapID = kAudioObjectUnknown;
static AudioObjectID gAggregateID = kAudioObjectUnknown;
static AudioDeviceIOProcID gIOProcID = NULL;
static dispatch_queue_t gIOQueue = NULL;
/** The AUDIO-TAP header is written once; a mute toggle rebuilds the tap but
    keeps the same stdout stream, so the reader never re-parses it. */
static BOOL gHeaderEmitted = NO;
/** Dispatch sources must stay referenced or ARC cancels them on scope exit. */
static NSMutableArray *gDispatchSources = nil;
/** Accumulates partial stdin lines between reads (mute/unmute commands). */
static NSMutableData *gStdinBuffer = nil;

/** Tears down the running tap chain (IOProc → aggregate → tap). */
static void stopTapChain(void) {
  if (gIOProcID != NULL && gAggregateID != kAudioObjectUnknown) {
    AudioDeviceStop(gAggregateID, gIOProcID);
    AudioDeviceDestroyIOProcID(gAggregateID, gIOProcID);
    gIOProcID = NULL;
  }
  if (gAggregateID != kAudioObjectUnknown) {
    AudioHardwareDestroyAggregateDevice(gAggregateID);
    gAggregateID = kAudioObjectUnknown;
  }
  if (gTapID != kAudioObjectUnknown) {
    if (@available(macOS 14.2, *)) AudioHardwareDestroyProcessTap(gTapID);
    gTapID = kAudioObjectUnknown;
  }
}

static void terminateTap(int code) {
  stopTapChain();
  exit(code);
}

/** Writes the whole buffer to stdout; NO on failure (reader gone). */
static BOOL writeAll(const void *bytes, size_t length) {
  const uint8_t *cursor = bytes;
  size_t remaining = length;
  while (remaining > 0) {
    ssize_t written = write(STDOUT_FILENO, cursor, remaining);
    if (written < 0) {
      if (errno == EINTR) continue;
      return NO;
    }
    cursor += written;
    remaining -= (size_t)written;
  }
  return YES;
}

/**
 * Install signal handling FIRST — teardown must work no matter which later
 * step blocks (AudioDeviceStart can stall behind a TCC prompt).
 */
static void installSignalHandling(void) {
  if (gDispatchSources == nil) gDispatchSources = [NSMutableArray array];
  signal(SIGPIPE, SIG_IGN);
  int signals[] = {SIGINT, SIGTERM};
  for (size_t i = 0; i < sizeof(signals) / sizeof(signals[0]); i++) {
    signal(signals[i], SIG_IGN);
    dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL,
                                                      (uintptr_t)signals[i], 0,
                                                      dispatch_get_main_queue());
    dispatch_source_set_event_handler(source, ^{ terminateTap(0); });
    dispatch_resume(source);
    [gDispatchSources addObject:source];
  }
}

/**
 * Builds and starts the tap chain for gTargetPID with the current gMuted state.
 * Emits the AUDIO-TAP header only on the first successful start. Hard-fails
 * with a mapped exit code on any Core Audio error.
 */
API_AVAILABLE(macos(14.4))
static void startTapChain(void) {
  AudioObjectID processObject = processObjectForPID(gTargetPID);
  if (processObject == kAudioObjectUnknown) {
    failWith(66, [NSString stringWithFormat:@"Process %d is not known to Core Audio (no audio activity).",
                                            gTargetPID]);
  }

  // Mono mixdown of everything the process plays — exactly the shape the
  // 16 kHz pipeline wants, no channel bookkeeping downstream.
  CATapDescription *description =
      [[CATapDescription alloc] initMonoMixdownOfProcesses:@[ @(processObject) ]];
  description.name = [NSString stringWithFormat:@"Translator tap (pid %d)", gTargetPID];
  description.privateTap = YES;
  // CATapMuted still captures the audio; it just isn't sent to the speakers —
  // exactly the dub-over behavior (hear the translation, not the original).
  description.muteBehavior = gMuted ? CATapMuted : CATapUnmuted;

  OSStatus tapErr = AudioHardwareCreateProcessTap(description, &gTapID);
  if (tapErr != noErr || gTapID == kAudioObjectUnknown) {
    // The dominant real-world cause is a TCC denial of System Audio Recording.
    failWith(77, [NSString stringWithFormat:@"AudioHardwareCreateProcessTap failed (OSStatus %d) — "
                                            @"likely missing the System Audio Recording permission.",
                                            (int)tapErr]);
  }

  AudioStreamBasicDescription format = {0};
  if (!getPodProperty(gTapID, kAudioTapPropertyFormat, &format, sizeof(format))) {
    terminateTap(70);
  }
  const char *sampleFormat = (format.mFormatFlags & kAudioFormatFlagIsFloat) ? "f32" : "s16";

  // The tap must live inside an aggregate device to be read from. Anchor it to
  // the default system output (AudioCap's pattern) so clocking is sane.
  AudioDeviceID systemOutput = 0;
  getPodProperty(kAudioObjectSystemObject, kAudioHardwarePropertyDefaultSystemOutputDevice,
                 &systemOutput, sizeof(systemOutput));
  NSString *outputUID = getStringProperty(systemOutput, kAudioDevicePropertyDeviceUID) ?: @"";

  NSDictionary *aggregateDescription = @{
    @kAudioAggregateDeviceNameKey : @"Translator Tap",
    @kAudioAggregateDeviceUIDKey : NSUUID.UUID.UUIDString,
    @kAudioAggregateDeviceMainSubDeviceKey : outputUID,
    @kAudioAggregateDeviceIsPrivateKey : @YES,
    @kAudioAggregateDeviceIsStackedKey : @NO,
    @kAudioAggregateDeviceTapAutoStartKey : @YES,
    @kAudioAggregateDeviceSubDeviceListKey : @[ @{@kAudioSubDeviceUIDKey : outputUID} ],
    @kAudioAggregateDeviceTapListKey : @[ @{
      @kAudioSubTapUIDKey : description.UUID.UUIDString,
      @kAudioSubTapDriftCompensationKey : @YES,
    } ],
  };

  OSStatus aggErr = AudioHardwareCreateAggregateDevice(
      (__bridge CFDictionaryRef)aggregateDescription, &gAggregateID);
  if (aggErr != noErr) {
    fprintf(stderr, "AudioHardwareCreateAggregateDevice failed (OSStatus %d)\n", (int)aggErr);
    terminateTap(70);
  }

  if (!gHeaderEmitted) {
    char header[128];
    int headerLength =
        snprintf(header, sizeof(header), "AUDIO-TAP 1 rate=%d channels=%u format=%s\n",
                 (int)format.mSampleRate, (unsigned)format.mChannelsPerFrame, sampleFormat);
    if (!writeAll(header, (size_t)headerLength)) terminateTap(0);
    gHeaderEmitted = YES;
  }

  if (gIOQueue == NULL) gIOQueue = dispatch_queue_create("translator.tap.io", DISPATCH_QUEUE_SERIAL);
  OSStatus ioErr = AudioDeviceCreateIOProcIDWithBlock(
      &gIOProcID, gAggregateID, gIOQueue,
      ^(const AudioTimeStamp *inNow, const AudioBufferList *inInputData,
        const AudioTimeStamp *inInputTime, AudioBufferList *outOutputData,
        const AudioTimeStamp *inOutputTime) {
        // Mono mixdown tap → a single buffer; write it straight through.
        for (UInt32 i = 0; i < inInputData->mNumberBuffers; i++) {
          const AudioBuffer *buffer = &inInputData->mBuffers[i];
          if (buffer->mData == NULL || buffer->mDataByteSize == 0) continue;
          if (!writeAll(buffer->mData, buffer->mDataByteSize)) {
            // stdout gone → parent died/stopped reading; wind down off-queue.
            dispatch_async(dispatch_get_main_queue(), ^{ terminateTap(0); });
          }
          break;
        }
      });
  if (ioErr != noErr || gIOProcID == NULL) {
    fprintf(stderr, "AudioDeviceCreateIOProcID failed (OSStatus %d)\n", (int)ioErr);
    terminateTap(70);
  }

  OSStatus startErr = AudioDeviceStart(gAggregateID, gIOProcID);
  if (startErr != noErr) {
    fprintf(stderr, "AudioDeviceStart failed (OSStatus %d)\n", (int)startErr);
    terminateTap(70);
  }
}

/**
 * Switches whether the tapped app's own output is silenced. muteBehavior is
 * fixed at tap-creation, so this rebuilds the chain in place; the same stdout
 * stream continues, so the reader sees only a brief gap, never a new header.
 */
API_AVAILABLE(macos(14.4))
static void applyMute(BOOL muted) {
  if (muted == gMuted) return;
  gMuted = muted;
  stopTapChain();
  startTapChain();
}

/** Reads available stdin and runs any complete `mute`/`unmute` command lines. */
API_AVAILABLE(macos(14.4))
static void handleStdinData(void) {
  char buf[256];
  ssize_t n = read(STDIN_FILENO, buf, sizeof(buf));
  if (n <= 0) return; // EOF or would-block — teardown is driven by signals/watchdog
  if (gStdinBuffer == nil) gStdinBuffer = [NSMutableData data];
  [gStdinBuffer appendBytes:buf length:(NSUInteger)n];

  for (;;) {
    const char *bytes = gStdinBuffer.bytes;
    NSUInteger length = gStdinBuffer.length, newline = NSNotFound;
    for (NSUInteger i = 0; i < length; i++) {
      if (bytes[i] == '\n') {
        newline = i;
        break;
      }
    }
    if (newline == NSNotFound) break;
    NSString *line = [[[NSString alloc] initWithBytes:bytes length:newline encoding:NSUTF8StringEncoding]
        stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
    [gStdinBuffer replaceBytesInRange:NSMakeRange(0, newline + 1) withBytes:NULL length:0];
    if ([line isEqualToString:@"mute"]) applyMute(YES);
    else if ([line isEqualToString:@"unmute"]) applyMute(NO);
  }
}

API_AVAILABLE(macos(14.4))
static void installStdinHandling(void) {
  fcntl(STDIN_FILENO, F_SETFL, fcntl(STDIN_FILENO, F_GETFL, 0) | O_NONBLOCK);
  dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, STDIN_FILENO, 0,
                                                    dispatch_get_main_queue());
  dispatch_source_set_event_handler(source, ^{ handleStdinData(); });
  dispatch_resume(source);
  [gDispatchSources addObject:source];
}

API_AVAILABLE(macos(14.4))
static void runTap(pid_t targetPID, BOOL muted) {
  gTargetPID = targetPID;
  gMuted = muted;
  installSignalHandling();
  installStdinHandling();
  startTapChain();

  // If the parent dies without killing us, don't linger as an orphan tap.
  dispatch_source_t parentWatch =
      dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
  dispatch_source_set_timer(parentWatch, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC),
                            2 * NSEC_PER_SEC, NSEC_PER_SEC / 4);
  dispatch_source_set_event_handler(parentWatch, ^{
    if (getppid() == 1) terminateTap(0);
  });
  dispatch_resume(parentWatch);
  [gDispatchSources addObject:parentWatch];

  dispatch_main();
}

// MARK: - entry point

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 2) failWith(64, @"Usage: audio-tap list | tap <pid>");

    if (@available(macOS 14.4, *)) {
      NSString *command = @(argv[1]);
      if ([command isEqualToString:@"list"]) {
        runList();
      } else if ([command isEqualToString:@"tap"]) {
        if (argc < 3) failWith(64, @"Usage: audio-tap tap <pid> [--muted]");
        pid_t pid = (pid_t)atoi(argv[2]);
        if (pid <= 0) failWith(64, [NSString stringWithFormat:@"Invalid pid: %s", argv[2]]);
        BOOL muted = (argc >= 4 && strcmp(argv[3], "--muted") == 0);
        runTap(pid, muted);
      } else {
        failWith(64, [NSString stringWithFormat:@"Unknown command: %s", argv[1]]);
      }
    } else {
      failWith(69, @"Per-process audio capture requires macOS 14.4 or newer.");
    }
  }
  return 0;
}
