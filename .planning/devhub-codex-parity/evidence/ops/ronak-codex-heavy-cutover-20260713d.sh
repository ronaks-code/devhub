#!/bin/sh
set -eu
LC_ALL=C
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export LC_ALL PATH
umask 077

BASE=/Users/ronak/.codex/bin
CANONICAL="$BASE/ronak-codex-heavy-queue"
POINTER="$BASE/ronak-codex-heavy-queue.current"
H="$BASE/ronak-codex-heavy-queue.impl-20260713h"
D="$BASE/ronak-codex-heavy-queue.impl-20260713d"
CANDIDATE="$BASE/ronak-codex-heavy-queue.launcher-20260713d"
MAINTENANCE="$BASE/ronak-codex-heavy-queue.impl-maintenance-20260713d"
LAUNCHER_BACKUP="$BASE/ronak-codex-heavy-queue.launcher-20260713h"

QUEUE=/tmp/ronak-codex-heavy.queue
OWNER=/tmp/ronak-codex-heavy.lock
REGISTRATION_LOCK=/tmp/ronak-codex-heavy.registration.lock
KERNEL_LOCK=/tmp/ronak-codex-heavy.kernel
AUDIT_LOCK=/tmp/ronak-codex-queue.audit.lock
STATE_LOCK=/tmp/ronak-codex-heavy.queue.state.lock
AUDIT_LOG=/tmp/ronak-codex-queue.jsonl
AUDIT_COUNTER=/tmp/ronak-codex-queue.audit-counter
COMPLETED="$QUEUE/completed-events"
SEQUENCE="$QUEUE/next-sequence"

EXPECTED_H=ca123183cb4b79cd43201bf34e7b3eccdb7318a7e422b0ac503dec46ccd28eab
EXPECTED_D=ce43d9efad1049d8208ef1bfcab18e9c98f26aab202c3829c8d1219e66c230f7
EXPECTED_OLD_LAUNCHER=dfa4962815db1dabd2125a6e55fa48c88c4546d925faede213d874303d0e54aa
EXPECTED_NEW_LAUNCHER=72d21eb32b47c7be8fa3807d34b74aa4b1e58e169d221e42fe63abbf2819c8af
EXPECTED_MAINTENANCE=b09ea1d4d26670578667faac0b5dd756920a3618998a4c270fa0ff9dc87b89af
EXPECTED_AUDIT=ba1789ca86dae05653e587bfc71360df94b9e69392261467a2af10125c7a5b34
EXPECTED_AUDIT_SIZE=10168
EXPECTED_AUDIT_INODE=91350682
EXPECTED_SEQUENCE_INODE=90241108
GUARD_VALUE=cutover-20260713d-lockset

sha256() {
  /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'
}

mode_of() {
  /usr/bin/stat -f '%Lp' "$1"
}

owner_of() {
  /usr/bin/stat -f '%u' "$1"
}

require_guard() {
  [ "${RONAK_CODEX_CUTOVER_GUARD:-}" = "$GUARD_VALUE" ] || exit 64
}

require_maintenance_pointer() {
  [ -L "$POINTER" ]
  [ "$(/usr/bin/readlink "$POINTER")" = ronak-codex-heavy-queue.impl-maintenance-20260713d ]
}

validate_immutable() {
  file=$1
  expected=$2
  [ -f "$file" ] && [ ! -L "$file" ]
  [ "$(owner_of "$file")" = "$(/usr/bin/id -u)" ]
  [ "$(mode_of "$file")" = 500 ]
  [ "$(sha256 "$file")" = "$expected" ]
}

drain_check() {
  require_maintenance_pointer
  [ ! -e "$OWNER" ] && [ ! -L "$OWNER" ]

  active=$(/usr/bin/find "$QUEUE" -mindepth 1 -maxdepth 1 \
    ! -name next-sequence ! -name completed-events -print -quit)
  [ -z "$active" ]

  process_report=/tmp/ronak-codex-heavy-cutover-processes.$$
  if /usr/bin/pgrep -lf '/Users/ronak/[.]codex/bin/ronak-codex-heavy-queue([.]impl-[A-Za-z0-9._-]+)?([[:space:]]|$)' > "$process_report"; then
    /bin/cat "$process_report" >&2
    /bin/rm -f "$process_report"
    return 75
  fi
  /bin/rm -f "$process_report"

  fd_report=/tmp/ronak-codex-heavy-cutover-fds.$$
  if /usr/sbin/lsof "$CANONICAL" "$POINTER" "$H" "$D" "$CANDIDATE" "$MAINTENANCE" > "$fd_report" 2>/dev/null; then
    /bin/cat "$fd_report" >&2
    /bin/rm -f "$fd_report"
    return 75
  fi
  /bin/rm -f "$fd_report"
}

ensure_state_lock() {
  /usr/bin/perl -MErrno=EEXIST -MFcntl=:DEFAULT,:mode -MIO::Handle -e '
    use strict;
    use warnings;
    my ($path, $uid) = @ARGV;
    if (!lstat($path)) {
      if (sysopen(my $out, $path, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0600)) {
        $out->sync or die "sync state lock: $!\n";
        close($out) or die "close state lock: $!\n";
      } else {
        die "create state lock: $!\n" unless $! == EEXIST;
      }
    }
    my @state = lstat($path);
    die "state lock missing\n" unless @state;
    die "state lock not regular\n" unless S_ISREG($state[2]);
    die "state lock owner mismatch\n" unless $state[4] == $uid;
    die "state lock mode mismatch\n" unless S_IMODE($state[2]) == 0600;
  ' "$STATE_LOCK" "$(/usr/bin/id -u)"
}

install_launcher() {
  validate_immutable "$CANDIDATE" "$EXPECTED_NEW_LAUNCHER"
  current_hash=$(sha256 "$CANONICAL")
  case "$current_hash" in
    "$EXPECTED_OLD_LAUNCHER")
      if [ ! -e "$LAUNCHER_BACKUP" ] && [ ! -L "$LAUNCHER_BACKUP" ]; then
        /bin/ln "$CANONICAL" "$LAUNCHER_BACKUP"
      fi
      [ ! -L "$LAUNCHER_BACKUP" ]
      [ "$(sha256 "$LAUNCHER_BACKUP")" = "$EXPECTED_OLD_LAUNCHER" ]
      [ "$(mode_of "$LAUNCHER_BACKUP")" = 500 ]
      launcher_tmp="$CANONICAL.cutover-$$"
      /bin/rm -f "$launcher_tmp"
      /bin/ln "$CANDIDATE" "$launcher_tmp"
      /bin/mv -f "$launcher_tmp" "$CANONICAL"
      ;;
    "$EXPECTED_NEW_LAUNCHER")
      [ -f "$LAUNCHER_BACKUP" ] && [ ! -L "$LAUNCHER_BACKUP" ]
      [ "$(sha256 "$LAUNCHER_BACKUP")" = "$EXPECTED_OLD_LAUNCHER" ]
      ;;
    *)
      printf 'unexpected canonical launcher hash: %s\n' "$current_hash" >&2
      return 73
      ;;
  esac
  validate_immutable "$CANONICAL" "$EXPECTED_NEW_LAUNCHER"
}

initialize_completed_events() {
  /usr/bin/perl -MFcntl=:mode -e '
    use strict;
    use warnings;
    my ($path, $uid) = @ARGV;
    mkdir($path, 0700) or die "create completed-events: $!\n" unless lstat($path);
    my @state = lstat($path);
    die "completed-events missing\n" unless @state;
    die "completed-events not directory\n" unless S_ISDIR($state[2]);
    die "completed-events owner mismatch\n" unless $state[4] == $uid;
    die "completed-events mode mismatch\n" unless S_IMODE($state[2]) == 0700;
  ' "$COMPLETED" "$(/usr/bin/id -u)"
}

migrate_sequence() {
  /usr/bin/perl -MFcntl=:DEFAULT,:mode -MIO::Handle -e '
    use strict;
    use warnings;
    my ($path, $uid, $expected_inode) = @ARGV;
    sysopen(my $fh, $path, O_RDWR | O_NOFOLLOW) or die "open sequence: $!\n";
    my @opened = stat($fh);
    die "sequence not regular\n" unless S_ISREG($opened[2]);
    die "sequence owner mismatch\n" unless $opened[4] == $uid;
    die "sequence inode mismatch\n" unless $opened[1] == $expected_inode;
    local $/;
    my $content = <$fh>;
    die "sequence content mismatch\n" unless defined($content) && $content eq "7\n";
    chmod(0600, $fh) or die "chmod sequence: $!\n";
    $fh->sync or die "sync sequence: $!\n";
    close($fh) or die "close sequence: $!\n";
    my @after = lstat($path);
    die "sequence path missing\n" unless @after;
    die "sequence path changed\n" unless $after[1] == $expected_inode;
    die "sequence mode mismatch\n" unless S_IMODE($after[2]) == 0600;
  ' "$SEQUENCE" "$(/usr/bin/id -u)" "$EXPECTED_SEQUENCE_INODE"
  [ "$(/usr/bin/stat -f '%i' "$SEQUENCE")" = "$EXPECTED_SEQUENCE_INODE" ]
  [ "$(mode_of "$SEQUENCE")" = 600 ]
  [ "$(/bin/cat "$SEQUENCE")" = 7 ]
}

initialize_audit_counter() {
  /usr/bin/perl -MFcntl=:DEFAULT,:mode -MIO::Handle -MJSON::PP=decode_json \
    -MTime::HiRes=time -MTime::Local=timegm -e '
      use strict;
      use warnings;
      my ($log, $counter, $queue, $uid) = @ARGV;
      sysopen(my $in, $log, O_RDONLY | O_NOFOLLOW) or die "open audit log: $!\n";
      my $max_ns = 0;
      my $lines = 0;
      while (my $line = <$in>) {
        $lines++;
        my $event = decode_json($line);
        die "audit event not object\n" unless ref($event) eq "HASH";
        my $ts = $event->{ts};
        die "audit timestamp missing\n" unless defined($ts);
        $ts =~ /\A(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:[.](\d{1,9}))?Z\z/
          or die "invalid audit timestamp: $ts\n";
        my ($year, $month, $day, $hour, $minute, $second, $fraction) =
          ($1, $2, $3, $4, $5, $6, defined($7) ? $7 : "");
        $fraction .= "0" x (9 - length($fraction));
        my $epoch = timegm($second, $minute, $hour, $day, $month - 1, $year);
        my $ns = $epoch * 1_000_000_000 + ($fraction eq "" ? 0 : $fraction);
        $max_ns = $ns if $ns > $max_ns;
      }
      close($in) or die "close audit log: $!\n";
      die "audit line count changed\n" unless $lines == 83;
      my $now_ns = int(time() * 1_000_000_000);
      my $seed = $now_ns > $max_ns ? $now_ns : $max_ns;
      if (!lstat($counter)) {
        my $tmp = "$queue/.audit-counter-migration.$$";
        sysopen(my $out, $tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600)
          or die "create audit counter temp: $!\n";
        my $payload = "$seed\n";
        my $written = syswrite($out, $payload, length($payload));
        die "short audit counter write\n"
          unless defined($written) && $written == length($payload);
        $out->sync or die "sync audit counter: $!\n";
        close($out) or die "close audit counter: $!\n";
        link($tmp, $counter) or die "publish audit counter: $!\n";
        unlink($tmp) or die "remove audit counter temp: $!\n";
      }
      my @state = lstat($counter);
      die "audit counter missing\n" unless @state;
      die "audit counter not regular\n" unless S_ISREG($state[2]);
      die "audit counter owner mismatch\n" unless $state[4] == $uid;
      die "audit counter mode mismatch\n" unless S_IMODE($state[2]) == 0600;
      sysopen(my $counter_in, $counter, O_RDONLY | O_NOFOLLOW)
        or die "open audit counter: $!\n";
      my $value = <$counter_in>;
      close($counter_in) or die "close audit counter: $!\n";
      chomp($value //= "");
      die "invalid audit counter\n" unless $value =~ /\A[0-9]{1,20}\z/;
      die "audit counter below historical maximum\n" unless $value >= $max_ns;
      print "$value\n";
    ' "$AUDIT_LOG" "$AUDIT_COUNTER" "$QUEUE" "$(/usr/bin/id -u)"
}

verify_audit_baseline() {
  [ "$(/usr/bin/stat -f '%i' "$AUDIT_LOG")" = "$EXPECTED_AUDIT_INODE" ]
  [ "$(/usr/bin/stat -f '%z' "$AUDIT_LOG")" = "$EXPECTED_AUDIT_SIZE" ]
  [ "$(sha256 "$AUDIT_LOG")" = "$EXPECTED_AUDIT" ]
  [ "$(mode_of "$AUDIT_LOG")" = 600 ]
  [ "$(owner_of "$AUDIT_LOG")" = "$(/usr/bin/id -u)" ]
}

point_to_d() {
  pointer_tmp="$POINTER.cutover-$$"
  /bin/rm -f "$pointer_tmp"
  /bin/ln -s ronak-codex-heavy-queue.impl-20260713d "$pointer_tmp"
  /bin/mv -f "$pointer_tmp" "$POINTER"
  [ "$(/usr/bin/readlink "$POINTER")" = ronak-codex-heavy-queue.impl-20260713d ]
}

case "${1:-}" in
  start)
    [ "$#" -eq 1 ]
    require_maintenance_pointer
    validate_immutable "$H" "$EXPECTED_H"
    validate_immutable "$D" "$EXPECTED_D"
    validate_immutable "$CANDIDATE" "$EXPECTED_NEW_LAUNCHER"
    validate_immutable "$MAINTENANCE" "$EXPECTED_MAINTENANCE"
    exec /usr/bin/env RONAK_CODEX_CUTOVER_GUARD="$GUARD_VALUE" \
      /usr/bin/lockf -k -s -t 0 "$REGISTRATION_LOCK" \
      /usr/bin/lockf -k -s -t 0 "$KERNEL_LOCK" \
      /usr/bin/lockf -k -s -t 0 "$AUDIT_LOCK" \
      "$0" __legacy_locked
    ;;
  __legacy_locked)
    [ "$#" -eq 1 ]
    require_guard
    require_maintenance_pointer
    ensure_state_lock
    exec /usr/bin/env RONAK_CODEX_CUTOVER_GUARD="$GUARD_VALUE" \
      /usr/bin/lockf -k -s -t 0 "$STATE_LOCK" "$0" __all_locked
    ;;
  __all_locked)
    [ "$#" -eq 1 ]
    require_guard
    drain_check
    validate_immutable "$H" "$EXPECTED_H"
    validate_immutable "$D" "$EXPECTED_D"
    validate_immutable "$CANDIDATE" "$EXPECTED_NEW_LAUNCHER"
    validate_immutable "$MAINTENANCE" "$EXPECTED_MAINTENANCE"
    verify_audit_baseline
    install_launcher
    initialize_completed_events
    migrate_sequence
    audit_seed=$(initialize_audit_counter)
    verify_audit_baseline
    drain_check
    validate_immutable "$CANONICAL" "$EXPECTED_NEW_LAUNCHER"
    validate_immutable "$D" "$EXPECTED_D"
    printf 'locked_cutover_precommit=pass audit_seed=%s audit_hash=%s audit_size=%s sequence_inode=%s sequence_content=7 launcher_hash=%s\n' \
      "$audit_seed" "$EXPECTED_AUDIT" "$EXPECTED_AUDIT_SIZE" \
      "$EXPECTED_SEQUENCE_INODE" "$EXPECTED_NEW_LAUNCHER"
    point_to_d
    ;;
  *)
    printf 'usage: %s start\n' "$0" >&2
    exit 64
    ;;
esac
