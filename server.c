/*
 * TaxiBook India — Pure C Backend Server (POSIX Sockets + pthreads + SQLite3 SQL)
 *
 * Implements the entire backend in pure C:
 *   1. Relational SQL Database (SQLite 3 via libsqlite3.so.0):
 *        - users    : Authenticated rider accounts (salted iterative SHA-256)
 *        - sessions : Secure HttpOnly session tokens
 *        - bookings : Persistent ride records with foreign key to users(id)
 *   2. Core ADS Dispatch Structures:
 *        - Struct Arrays      : Ground-truth Indian pricing & driver pools
 *        - Hash Table (djb2)  : O(1) vehicle tier lookup
 *        - FIFO Queue         : Ride dispatch request pipeline
 *   3. Static File Server:
 *        - Serves the built Vite React frontend from ./dist
 *
 * Compile: gcc -O2 -Wall -Wextra -pthread -o server_bin server.c -lm -ldl
 * Run:     ./server_bin
 */

#define _POSIX_C_SOURCE 200809L

#include <arpa/inet.h>
#include <ctype.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <netinet/in.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#define DEFAULT_PORT 3000
#define REQ_BUF_SIZE 65536
#define HASH_BUCKETS 16
#define DRIVERS_PER_TIER 5
#define NUM_TIERS 3
#define DIST_ROOT "./dist"
#define DB_PATH "./taxibook.db"
#define SESSION_COOKIE_NAME "taxibook_session"

/* ── Dynamic SQLite3 C API Binding (libsqlite3.so.0) ─────────────────── */

typedef struct sqlite3 sqlite3;
typedef struct sqlite3_stmt sqlite3_stmt;

#define SQLITE_OK 0
#define SQLITE_ROW 100
#define SQLITE_DONE 101
#define SQLITE_TRANSIENT ((void (*)(void *))-1)

typedef struct {
    void *handle;
    int (*open)(const char *, sqlite3 **);
    int (*close)(sqlite3 *);
    int (*exec)(sqlite3 *, const char *, int (*)(void *, int, char **, char **), void *, char **);
    int (*prepare_v2)(sqlite3 *, const char *, int, sqlite3_stmt **, const char **);
    int (*step)(sqlite3_stmt *);
    int (*finalize)(sqlite3_stmt *);
    int (*bind_text)(sqlite3_stmt *, int, const char *, int, void (*)(void *));
    int (*bind_double)(sqlite3_stmt *, int, double);
    int (*bind_int)(sqlite3_stmt *, int, int);
    int (*bind_int64)(sqlite3_stmt *, int, int64_t);
    const unsigned char *(*column_text)(sqlite3_stmt *, int);
    double (*column_double)(sqlite3_stmt *, int);
    int (*column_int)(sqlite3_stmt *, int);
    int64_t (*column_int64)(sqlite3_stmt *, int);
    int64_t (*last_insert_rowid)(sqlite3 *);
    int (*changes)(sqlite3 *);
    const char *(*errmsg)(sqlite3 *);
    int (*busy_timeout)(sqlite3 *, int);
} SqliteApi;

static SqliteApi sq;
static sqlite3 *db = NULL;
static pthread_mutex_t db_mutex = PTHREAD_MUTEX_INITIALIZER;

static int load_sqlite_api(void) {
    const char *candidates[] = {
        "/usr/lib/x86_64-linux-gnu/libsqlite3.so.0",
        "libsqlite3.so.0",
        "libsqlite3.so",
        NULL
    };
    for (int i = 0; candidates[i] != NULL; i++) {
        sq.handle = dlopen(candidates[i], RTLD_LAZY);
        if (sq.handle) break;
    }
    if (!sq.handle) {
        fprintf(stderr, "Failed to load libsqlite3: %s\n", dlerror());
        return 0;
    }

    sq.open = dlsym(sq.handle, "sqlite3_open");
    sq.close = dlsym(sq.handle, "sqlite3_close");
    sq.exec = dlsym(sq.handle, "sqlite3_exec");
    sq.prepare_v2 = dlsym(sq.handle, "sqlite3_prepare_v2");
    sq.step = dlsym(sq.handle, "sqlite3_step");
    sq.finalize = dlsym(sq.handle, "sqlite3_finalize");
    sq.bind_text = dlsym(sq.handle, "sqlite3_bind_text");
    sq.bind_double = dlsym(sq.handle, "sqlite3_bind_double");
    sq.bind_int = dlsym(sq.handle, "sqlite3_bind_int");
    sq.bind_int64 = dlsym(sq.handle, "sqlite3_bind_int64");
    sq.column_text = dlsym(sq.handle, "sqlite3_column_text");
    sq.column_double = dlsym(sq.handle, "sqlite3_column_double");
    sq.column_int = dlsym(sq.handle, "sqlite3_column_int");
    sq.column_int64 = dlsym(sq.handle, "sqlite3_column_int64");
    sq.last_insert_rowid = dlsym(sq.handle, "sqlite3_last_insert_rowid");
    sq.changes = dlsym(sq.handle, "sqlite3_changes");
    sq.errmsg = dlsym(sq.handle, "sqlite3_errmsg");
    sq.busy_timeout = dlsym(sq.handle, "sqlite3_busy_timeout");

    return sq.open && sq.close && sq.exec && sq.prepare_v2 && sq.step && sq.finalize &&
           sq.bind_text && sq.bind_double && sq.bind_int && sq.bind_int64 &&
           sq.column_text && sq.column_double && sq.column_int && sq.column_int64 &&
           sq.last_insert_rowid && sq.changes && sq.errmsg;
}

static int init_database(void) {
    if (!load_sqlite_api()) return 0;
    if (sq.open(DB_PATH, &db) != SQLITE_OK) {
        fprintf(stderr, "Cannot open SQLite database %s: %s\n", DB_PATH, db ? sq.errmsg(db) : "OOM");
        return 0;
    }
    if (sq.busy_timeout) sq.busy_timeout(db, 5000);

    const char *schema_sql =
        "PRAGMA foreign_keys = ON;"
        "PRAGMA journal_mode = WAL;"
        "CREATE TABLE IF NOT EXISTS users ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  uid TEXT NOT NULL UNIQUE,"
        "  display_name TEXT NOT NULL,"
        "  email TEXT NOT NULL UNIQUE,"
        "  password_hash TEXT NOT NULL,"
        "  salt TEXT NOT NULL,"
        "  default_phone TEXT NOT NULL DEFAULT '',"
        "  role TEXT NOT NULL DEFAULT 'rider' CHECK (role IN ('rider')),"
        "  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),"
        "  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))"
        ");"
        "CREATE TABLE IF NOT EXISTS sessions ("
        "  token TEXT PRIMARY KEY,"
        "  user_id INTEGER NOT NULL,"
        "  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),"
        "  expires_at TEXT NOT NULL,"
        "  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE"
        ");"
        "CREATE TABLE IF NOT EXISTS bookings ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  user_id INTEGER NOT NULL,"
        "  booking_code TEXT NOT NULL UNIQUE,"
        "  passenger_name TEXT NOT NULL,"
        "  passenger_phone TEXT NOT NULL,"
        "  vehicle TEXT NOT NULL CHECK (vehicle IN ('bike', 'auto', 'car')),"
        "  pickup_lat REAL NOT NULL,"
        "  pickup_lng REAL NOT NULL,"
        "  pickup_label TEXT NOT NULL,"
        "  dest_lat REAL NOT NULL,"
        "  dest_lng REAL NOT NULL,"
        "  dest_label TEXT NOT NULL,"
        "  distance_km REAL NOT NULL,"
        "  duration_min REAL NOT NULL,"
        "  base_fare REAL NOT NULL,"
        "  per_km_rate REAL NOT NULL,"
        "  fare_inr REAL NOT NULL,"
        "  driver_name TEXT NOT NULL,"
        "  driver_phone TEXT NOT NULL,"
        "  plate_number TEXT NOT NULL,"
        "  status TEXT NOT NULL DEFAULT 'dispatched' CHECK (status IN ('dispatched', 'completed', 'cancelled')),"
        "  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),"
        "  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),"
        "  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE"
        ");"
        "CREATE INDEX IF NOT EXISTS idx_bookings_user_id ON bookings(user_id);"
        "CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);";

    char *err_msg = NULL;
    if (sq.exec(db, schema_sql, NULL, NULL, &err_msg) != SQLITE_OK) {
        fprintf(stderr, "SQLite schema initialization failed: %s\n", err_msg ? err_msg : "unknown");
        return 0;
    }
    return 1;
}

/* ── Self-Contained SHA-256 & CSPRNG Helpers ─────────────────────────── */

static const uint32_t SHA256_K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
};

#define ROR32(x, n) (((x) >> (n)) | ((x) << (32 - (n))))

static void sha256_bytes(const uint8_t *data, size_t len, uint8_t out[32]) {
    uint32_t state[8] = {
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    };

    size_t bit_len = len * 8;
    size_t padded_len = ((len + 9 + 63) / 64) * 64;
    uint8_t *msg = calloc(1, padded_len);
    if (!msg) return;
    memcpy(msg, data, len);
    msg[len] = 0x80;
    for (int i = 0; i < 8; i++) {
        msg[padded_len - 1 - i] = (uint8_t)((bit_len >> (i * 8)) & 0xff);
    }

    for (size_t offset = 0; offset < padded_len; offset += 64) {
        uint32_t w[64];
        for (int i = 0; i < 16; i++) {
            w[i] = ((uint32_t)msg[offset + i * 4] << 24) |
                   ((uint32_t)msg[offset + i * 4 + 1] << 16) |
                   ((uint32_t)msg[offset + i * 4 + 2] << 8) |
                   ((uint32_t)msg[offset + i * 4 + 3]);
        }
        for (int i = 16; i < 64; i++) {
            uint32_t s0 = ROR32(w[i - 15], 7) ^ ROR32(w[i - 15], 18) ^ (w[i - 15] >> 3);
            uint32_t s1 = ROR32(w[i - 2], 17) ^ ROR32(w[i - 2], 19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }
        uint32_t a = state[0], b = state[1], c = state[2], d = state[3];
        uint32_t e = state[4], f = state[5], g = state[6], h = state[7];
        for (int i = 0; i < 64; i++) {
            uint32_t S1 = ROR32(e, 6) ^ ROR32(e, 11) ^ ROR32(e, 25);
            uint32_t ch = (e & f) ^ ((~e) & g);
            uint32_t temp1 = h + S1 + ch + SHA256_K[i] + w[i];
            uint32_t S0 = ROR32(a, 2) ^ ROR32(a, 13) ^ ROR32(a, 22);
            uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
            uint32_t temp2 = S0 + maj;
            h = g; g = f; f = e; e = d + temp1;
            d = c; c = b; b = a; a = temp1 + temp2;
        }
        state[0] += a; state[1] += b; state[2] += c; state[3] += d;
        state[4] += e; state[5] += f; state[6] += g; state[7] += h;
    }
    free(msg);

    for (int i = 0; i < 8; i++) {
        out[i * 4]     = (uint8_t)((state[i] >> 24) & 0xff);
        out[i * 4 + 1] = (uint8_t)((state[i] >> 16) & 0xff);
        out[i * 4 + 2] = (uint8_t)((state[i] >> 8) & 0xff);
        out[i * 4 + 3] = (uint8_t)(state[i] & 0xff);
    }
}

static void random_hex(char *out, size_t byte_count) {
    uint8_t buf[64];
    if (byte_count > sizeof(buf)) byte_count = sizeof(buf);
    int fd = open("/dev/urandom", O_RDONLY);
    if (fd >= 0) {
        size_t got = 0;
        while (got < byte_count) {
            ssize_t r = read(fd, buf + got, byte_count - got);
            if (r <= 0) break;
            got += (size_t)r;
        }
        close(fd);
    } else {
        for (size_t i = 0; i < byte_count; i++) buf[i] = (uint8_t)(rand() & 0xff);
    }
    for (size_t i = 0; i < byte_count; i++) {
        sprintf(out + i * 2, "%02x", buf[i]);
    }
    out[byte_count * 2] = '\0';
}

static void hash_password_salted(const char *salt_hex, const char *password, char out_hex[65]) {
    uint8_t digest[32];
    size_t slen = strlen(salt_hex);
    size_t plen = strlen(password);
    uint8_t *buf = malloc(slen + plen + 1);
    if (!buf) {
        out_hex[0] = '\0';
        return;
    }
    memcpy(buf, salt_hex, slen);
    buf[slen] = ':';
    memcpy(buf + slen + 1, password, plen);
    sha256_bytes(buf, slen + 1 + plen, digest);
    free(buf);

    for (int round = 0; round < 4096; round++) {
        sha256_bytes(digest, 32, digest);
    }
    for (int i = 0; i < 32; i++) {
        sprintf(out_hex + i * 2, "%02x", digest[i]);
    }
    out_hex[64] = '\0';
}

static int constant_time_equal(const char *a, const char *b) {
    size_t la = strlen(a), lb = strlen(b);
    if (la != lb) return 0;
    unsigned char diff = 0;
    for (size_t i = 0; i < la; i++) diff |= (unsigned char)(a[i] ^ b[i]);
    return diff == 0;
}

/* ── Core ADS Structures: Pricing Table, Driver Pools, Hash Table, FIFO Queue ── */

typedef struct {
    const char *key;
    const char *label;
    int seats;
    double base_fare;
    double per_km_rate;
    int tier_index;
} VehicleRate;

typedef struct {
    const char *name;
    const char *phone;
    const char *plate;
} Driver;

static const VehicleRate RATE_TABLE[NUM_TIERS] = {
    { "bike", "Bike Moto",     1, 20.0,  8.0, 0 },
    { "auto", "Auto Rickshaw", 3, 30.0, 12.0, 1 },
    { "car",  "Car AC",        4, 50.0, 18.0, 2 }
};

static const Driver DRIVER_POOLS[NUM_TIERS][DRIVERS_PER_TIER] = {
    {
        { "Rajesh Kumar",  "+91 98101 23456", "DL 01 AB 1234" },
        { "Amit Sharma",   "+91 99887 65432", "MH 02 CD 5678" },
        { "Vikram Singh",  "+91 97654 32100", "KA 03 EF 9012" },
        { "Sunil Yadav",   "+91 88765 43210", "UP 14 GH 3456" },
        { "Deepak Verma",  "+91 91234 56789", "TN 07 IJ 7890" }
    },
    {
        { "Manoj Patil",   "+91 98765 11223", "MH 04 KL 2345" },
        { "Ravi Tiwari",   "+91 87654 33445", "DL 05 MN 6789" },
        { "Ganesh Reddy",  "+91 96543 55667", "AP 09 OP 0123" },
        { "Arjun Nair",    "+91 85432 77889", "KL 10 QR 4567" },
        { "Sanjay Gupta",  "+91 94321 99001", "RJ 14 ST 8901" }
    },
    {
        { "Pradeep Mishra", "+91 99876 12345", "DL 02 UV 1122" },
        { "Karan Malhotra", "+91 88765 23456", "MH 01 WX 3344" },
        { "Anil Deshmukh",  "+91 77654 34567", "KA 05 YZ 5566" },
        { "Rohit Joshi",    "+91 66543 45678", "TN 09 AA 7788" },
        { "Naveen Pillai",  "+91 55432 56789", "GJ 06 BB 9900" }
    }
};

typedef struct RateHashNode {
    const VehicleRate *rate;
    struct RateHashNode *next;
} RateHashNode;

static RateHashNode *rate_hash_table[HASH_BUCKETS];

static unsigned long djb2_hash(const char *str) {
    unsigned long hash = 5381;
    int c;
    while ((c = (unsigned char)*str++) != 0) {
        hash = ((hash << 5) + hash) + (unsigned long)tolower(c);
    }
    return hash;
}

static void init_rate_hash_table(void) {
    memset(rate_hash_table, 0, sizeof(rate_hash_table));
    for (int i = 0; i < NUM_TIERS; i++) {
        unsigned long idx = djb2_hash(RATE_TABLE[i].key) % HASH_BUCKETS;
        RateHashNode *node = malloc(sizeof(RateHashNode));
        if (!node) exit(EXIT_FAILURE);
        node->rate = &RATE_TABLE[i];
        node->next = rate_hash_table[idx];
        rate_hash_table[idx] = node;
    }
}

static const VehicleRate *lookup_vehicle_rate(const char *vehicle) {
    if (!vehicle || !*vehicle) return NULL;
    unsigned long idx = djb2_hash(vehicle) % HASH_BUCKETS;
    RateHashNode *cur = rate_hash_table[idx];
    while (cur) {
        if (strcasecmp(cur->rate->key, vehicle) == 0) return cur->rate;
        cur = cur->next;
    }
    return NULL;
}

typedef struct {
    double start_lat;
    double start_lng;
    double end_lat;
    double end_lng;
    double override_distance_km;
    char vehicle[16];
} RideRequest;

typedef struct QueueNode {
    RideRequest req;
    struct QueueNode *next;
} QueueNode;

typedef struct {
    QueueNode *front;
    QueueNode *rear;
} RideQueue;

static RideQueue dispatch_queue = { NULL, NULL };

static void enqueue_request(const RideRequest *req) {
    QueueNode *node = malloc(sizeof(QueueNode));
    if (!node) return;
    node->req = *req;
    node->next = NULL;
    if (!dispatch_queue.rear) {
        dispatch_queue.front = node;
        dispatch_queue.rear = node;
    } else {
        dispatch_queue.rear->next = node;
        dispatch_queue.rear = node;
    }
}

static int dequeue_request(RideRequest *out) {
    if (!dispatch_queue.front) return 0;
    QueueNode *node = dispatch_queue.front;
    *out = node->req;
    dispatch_queue.front = node->next;
    if (!dispatch_queue.front) dispatch_queue.rear = NULL;
    free(node);
    return 1;
}

/* ── Geodesic, URL & JSON Helpers ────────────────────────────────────── */

static double to_radians(double deg) {
    return deg * M_PI / 180.0;
}

static double haversine_km(double lat1, double lng1, double lat2, double lng2) {
    const double R = 6371.0;
    double d_lat = to_radians(lat2 - lat1);
    double d_lng = to_radians(lng2 - lng1);
    double a = sin(d_lat / 2.0) * sin(d_lat / 2.0) +
               cos(to_radians(lat1)) * cos(to_radians(lat2)) *
               sin(d_lng / 2.0) * sin(d_lng / 2.0);
    return R * 2.0 * atan2(sqrt(a), sqrt(1.0 - a));
}

static double round_two(double val) {
    return round(val * 100.0) / 100.0;
}

static int parse_double_strict(const char *str, double *out) {
    if (!str || !*str) return 0;
    char *end = NULL;
    errno = 0;
    double val = strtod(str, &end);
    if (errno != 0 || end == str || *end != '\0' || !isfinite(val)) return 0;
    *out = val;
    return 1;
}

static void url_decode(const char *src, char *dst, size_t dst_size) {
    size_t di = 0;
    for (size_t si = 0; src[si] != '\0' && di + 1 < dst_size; si++) {
        if (src[si] == '+') {
            dst[di++] = ' ';
        } else if (src[si] == '%' &&
                   isxdigit((unsigned char)src[si + 1]) &&
                   isxdigit((unsigned char)src[si + 2])) {
            char hex[3] = { src[si + 1], src[si + 2], '\0' };
            dst[di++] = (char)strtol(hex, NULL, 16);
            si += 2;
        } else {
            dst[di++] = src[si];
        }
    }
    dst[di] = '\0';
}

static int get_query_param(const char *query, const char *key, char *out, size_t out_size) {
    if (!query || !*query || !key) return 0;
    size_t key_len = strlen(key);
    const char *p = query;
    while (*p) {
        const char *amp = strchr(p, '&');
        size_t pair_len = amp ? (size_t)(amp - p) : strlen(p);
        const char *eq = memchr(p, '=', pair_len);
        if (eq) {
            size_t klen = (size_t)(eq - p);
            if (klen == key_len && strncmp(p, key, key_len) == 0) {
                size_t vlen = pair_len - klen - 1;
                char encoded[512];
                if (vlen >= sizeof(encoded)) vlen = sizeof(encoded) - 1;
                memcpy(encoded, eq + 1, vlen);
                encoded[vlen] = '\0';
                url_decode(encoded, out, out_size);
                return 1;
            }
        }
        if (!amp) break;
        p = amp + 1;
    }
    return 0;
}

static void json_escape(const char *src, char *dst, size_t dst_size) {
    if (!src) {
        if (dst_size > 0) dst[0] = '\0';
        return;
    }
    size_t di = 0;
    for (size_t si = 0; src[si] != '\0' && di + 6 < dst_size; si++) {
        unsigned char c = (unsigned char)src[si];
        if (c == '"' || c == '\\') {
            dst[di++] = '\\';
            dst[di++] = (char)c;
        } else if (c == '\n') {
            dst[di++] = '\\';
            dst[di++] = 'n';
        } else if (c == '\r') {
            dst[di++] = '\\';
            dst[di++] = 'r';
        } else if (c == '\t') {
            dst[di++] = '\\';
            dst[di++] = 't';
        } else if (c >= 0x20) {
            dst[di++] = (char)c;
        }
    }
    dst[di] = '\0';
}

/* Minimal, safe JSON key extraction for flat request payloads */
static const char *find_json_key_value(const char *json, const char *key) {
    if (!json || !key) return NULL;
    char pattern[128];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    const char *p = json;
    while ((p = strstr(p, pattern)) != NULL) {
        const char *after = p + strlen(pattern);
        while (*after && isspace((unsigned char)*after)) after++;
        if (*after == ':') {
            after++;
            while (*after && isspace((unsigned char)*after)) after++;
            return after;
        }
        p = after;
    }
    return NULL;
}

static int json_get_string(const char *json, const char *key, char *out, size_t out_size) {
    const char *v = find_json_key_value(json, key);
    if (!v || *v != '"') return 0;
    v++;
    size_t di = 0;
    while (*v && *v != '"' && di + 1 < out_size) {
        if (*v == '\\' && *(v + 1)) {
            v++;
            if (*v == 'n') out[di++] = '\n';
            else if (*v == 'r') out[di++] = '\r';
            else if (*v == 't') out[di++] = '\t';
            else out[di++] = *v;
        } else {
            out[di++] = *v;
        }
        v++;
    }
    out[di] = '\0';
    return (*v == '"');
}

static int json_get_double(const char *json, const char *key, double *out) {
    const char *v = find_json_key_value(json, key);
    if (!v) return 0;
    char *end = NULL;
    errno = 0;
    double val = strtod(v, &end);
    if (errno != 0 || end == v || !isfinite(val)) return 0;
    *out = val;
    return 1;
}

static void trim_whitespace(char *str) {
    size_t len = strlen(str);
    size_t start = 0;
    while (start < len && isspace((unsigned char)str[start])) start++;
    while (len > start && isspace((unsigned char)str[len - 1])) len--;
    if (start > 0) memmove(str, str + start, len - start);
    str[len - start] = '\0';
}

static void lowercase_str(char *str) {
    for (size_t i = 0; str[i]; i++) str[i] = (char)tolower((unsigned char)str[i]);
}

/* ── HTTP Socket & Cookie Helpers ────────────────────────────────────── */

static int send_all(int fd, const char *buf, size_t len) {
    size_t sent = 0;
    while (sent < len) {
        ssize_t n = send(fd, buf + sent, len - sent, 0);
        if (n < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (n == 0) return -1;
        sent += (size_t)n;
    }
    return 0;
}

static void send_http_response(
    int fd,
    int status_code,
    const char *status_text,
    const char *content_type,
    const char *extra_headers,
    const char *body,
    size_t body_len,
    int head_only
) {
    char header[2048];
    int header_len = snprintf(
        header,
        sizeof(header),
        "HTTP/1.1 %d %s\r\n"
        "Content-Type: %s\r\n"
        "Content-Length: %zu\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "%s"
        "Connection: close\r\n"
        "\r\n",
        status_code,
        status_text,
        content_type,
        body_len,
        extra_headers ? extra_headers : ""
    );

    if (header_len > 0) {
        if (send_all(fd, header, (size_t)header_len) == 0 && !head_only && body && body_len > 0) {
            send_all(fd, body, body_len);
        }
    }
}

static void send_json(int fd, int status_code, const char *status_text, const char *json, int head_only) {
    send_http_response(
        fd,
        status_code,
        status_text,
        "application/json; charset=utf-8",
        "Cache-Control: no-store\r\n",
        json,
        strlen(json),
        head_only
    );
}

static void send_json_with_headers(
    int fd,
    int status_code,
    const char *status_text,
    const char *extra_headers,
    const char *json,
    int head_only
) {
    char combined[1024];
    snprintf(combined, sizeof(combined), "Cache-Control: no-store\r\n%s", extra_headers ? extra_headers : "");
    send_http_response(
        fd,
        status_code,
        status_text,
        "application/json; charset=utf-8",
        combined,
        json,
        strlen(json),
        head_only
    );
}

static int extract_header_value(const char *raw_headers, const char *header_name, char *out, size_t out_size) {
    size_t name_len = strlen(header_name);
    const char *line = raw_headers;
    while (line && *line) {
        const char *eol = strstr(line, "\r\n");
        size_t line_len = eol ? (size_t)(eol - line) : strlen(line);
        if (line_len == 0) break;
        if (line_len > name_len + 1 && strncasecmp(line, header_name, name_len) == 0 && line[name_len] == ':') {
            const char *val = line + name_len + 1;
            size_t vlen = line_len - name_len - 1;
            while (vlen > 0 && (*val == ' ' || *val == '\t')) {
                val++;
                vlen--;
            }
            if (vlen >= out_size) vlen = out_size - 1;
            memcpy(out, val, vlen);
            out[vlen] = '\0';
            return 1;
        }
        if (!eol) break;
        line = eol + 2;
    }
    return 0;
}

static int extract_session_token(const char *raw_headers, char *token_out, size_t out_size) {
    char auth_hdr[512];
    if (extract_header_value(raw_headers, "Authorization", auth_hdr, sizeof(auth_hdr))) {
        if (strncasecmp(auth_hdr, "Bearer ", 7) == 0) {
            snprintf(token_out, out_size, "%s", auth_hdr + 7);
            trim_whitespace(token_out);
            if (*token_out) return 1;
        }
    }

    char cookie_hdr[2048];
    if (extract_header_value(raw_headers, "Cookie", cookie_hdr, sizeof(cookie_hdr))) {
        const char *p = cookie_hdr;
        size_t cname_len = strlen(SESSION_COOKIE_NAME);
        while (*p) {
            while (*p == ' ' || *p == ';') p++;
            if (strncmp(p, SESSION_COOKIE_NAME, cname_len) == 0 && p[cname_len] == '=') {
                const char *val = p + cname_len + 1;
                const char *semi = strchr(val, ';');
                size_t len = semi ? (size_t)(semi - val) : strlen(val);
                if (len >= out_size) len = out_size - 1;
                memcpy(token_out, val, len);
                token_out[len] = '\0';
                trim_whitespace(token_out);
                if (*token_out) return 1;
            }
            const char *next = strchr(p, ';');
            if (!next) break;
            p = next + 1;
        }
    }
    return 0;
}

/* ── Authenticated User Lookup from SQLite ───────────────────────────── */

typedef struct {
    int64_t id;
    char uid[64];
    char display_name[96];
    char email[180];
    char default_phone[32];
    char role[16];
} AuthUser;

static int authenticate_request(const char *raw_headers, AuthUser *user_out) {
    char token[128] = "";
    if (!extract_session_token(raw_headers, token, sizeof(token))) return 0;

    pthread_mutex_lock(&db_mutex);
    sqlite3_stmt *stmt = NULL;
    const char *sql =
        "SELECT u.id, u.uid, u.display_name, u.email, u.default_phone, u.role "
        "FROM sessions s "
        "INNER JOIN users u ON u.id = s.user_id "
        "WHERE s.token = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now') "
        "LIMIT 1;";

    int ok = 0;
    if (sq.prepare_v2(db, sql, -1, &stmt, NULL) == SQLITE_OK) {
        sq.bind_text(stmt, 1, token, -1, SQLITE_TRANSIENT);
        if (sq.step(stmt) == SQLITE_ROW) {
            user_out->id = sq.column_int64(stmt, 0);
            const unsigned char *uid = sq.column_text(stmt, 1);
            const unsigned char *name = sq.column_text(stmt, 2);
            const unsigned char *email = sq.column_text(stmt, 3);
            const unsigned char *phone = sq.column_text(stmt, 4);
            const unsigned char *role = sq.column_text(stmt, 5);
            snprintf(user_out->uid, sizeof(user_out->uid), "%s", uid ? (const char *)uid : "");
            snprintf(user_out->display_name, sizeof(user_out->display_name), "%s", name ? (const char *)name : "Rider");
            snprintf(user_out->email, sizeof(user_out->email), "%s", email ? (const char *)email : "");
            snprintf(user_out->default_phone, sizeof(user_out->default_phone), "%s", phone ? (const char *)phone : "");
            snprintf(user_out->role, sizeof(user_out->role), "%s", role ? (const char *)role : "rider");
            ok = 1;
        }
        sq.finalize(stmt);
    }
    pthread_mutex_unlock(&db_mutex);
    return ok;
}

static void format_user_json(const AuthUser *u, char *out, size_t out_size) {
    char e_uid[128], e_name[200], e_email[360], e_phone[64];
    json_escape(u->uid, e_uid, sizeof(e_uid));
    json_escape(u->display_name, e_name, sizeof(e_name));
    json_escape(u->email, e_email, sizeof(e_email));
    json_escape(u->default_phone, e_phone, sizeof(e_phone));
    snprintf(
        out,
        out_size,
        "{\"uid\":\"%s\",\"displayName\":\"%s\",\"email\":\"%s\",\"defaultPhone\":\"%s\",\"role\":\"%s\"}",
        e_uid, e_name, e_email, e_phone, u->role
    );
}

static int create_session_token(int64_t user_id, char token_out[65]) {
    random_hex(token_out, 32);
    pthread_mutex_lock(&db_mutex);
    sqlite3_stmt *stmt = NULL;
    const char *sql =
        "INSERT INTO sessions (token, user_id, expires_at) "
        "VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+14 days'));";
    int ok = 0;
    if (sq.prepare_v2(db, sql, -1, &stmt, NULL) == SQLITE_OK) {
        sq.bind_text(stmt, 1, token_out, -1, SQLITE_TRANSIENT);
        sq.bind_int64(stmt, 2, user_id);
        ok = (sq.step(stmt) == SQLITE_DONE);
        sq.finalize(stmt);
    }
    pthread_mutex_unlock(&db_mutex);
    return ok;
}

/* ── Auth API Handlers ───────────────────────────────────────────────── */

static void handle_auth_register(int fd, const char *body) {
    char display_name[96] = "";
    char email[180] = "";
    char password[128] = "";

    json_get_string(body, "displayName", display_name, sizeof(display_name));
    json_get_string(body, "email", email, sizeof(email));
    json_get_string(body, "password", password, sizeof(password));

    trim_whitespace(display_name);
    trim_whitespace(email);
    lowercase_str(email);

    if (strlen(display_name) < 1 || strlen(display_name) > 80) {
        send_json(fd, 400, "Bad Request", "{\"error\":\"Full name must be 1 to 80 characters.\"}", 0);
        return;
    }
    const char *at = strchr(email, '@');
    const char *dot = at ? strchr(at, '.') : NULL;
    if (!at || !dot || strlen(email) < 5 || strlen(email) > 160) {
        send_json(fd, 400, "Bad Request", "{\"error\":\"Please enter a valid email address.\"}", 0);
        return;
    }
    if (strlen(password) < 6) {
        send_json(fd, 400, "Bad Request", "{\"error\":\"Password must be at least 6 characters.\"}", 0);
        return;
    }

    char salt[33];
    char pw_hash[65];
    char uid[40];
    char rand_uid[17];
    random_hex(salt, 16);
    hash_password_salted(salt, password, pw_hash);
    random_hex(rand_uid, 8);
    snprintf(uid, sizeof(uid), "usr_%s", rand_uid);

    int64_t new_user_id = 0;
    int duplicate = 0;

    pthread_mutex_lock(&db_mutex);
    sqlite3_stmt *stmt = NULL;
    const char *sql =
        "INSERT INTO users (uid, display_name, email, password_hash, salt, default_phone, role) "
        "VALUES (?, ?, ?, ?, ?, '', 'rider');";
    if (sq.prepare_v2(db, sql, -1, &stmt, NULL) == SQLITE_OK) {
        sq.bind_text(stmt, 1, uid, -1, SQLITE_TRANSIENT);
        sq.bind_text(stmt, 2, display_name, -1, SQLITE_TRANSIENT);
        sq.bind_text(stmt, 3, email, -1, SQLITE_TRANSIENT);
        sq.bind_text(stmt, 4, pw_hash, -1, SQLITE_TRANSIENT);
        sq.bind_text(stmt, 5, salt, -1, SQLITE_TRANSIENT);
        int rc = sq.step(stmt);
        if (rc == SQLITE_DONE) {
            new_user_id = sq.last_insert_rowid(db);
        } else {
            const char *msg = sq.errmsg(db);
            if (msg && strstr(msg, "UNIQUE") != NULL) duplicate = 1;
        }
        sq.finalize(stmt);
    }
    pthread_mutex_unlock(&db_mutex);

    if (duplicate) {
        send_json(fd, 409, "Conflict", "{\"error\":\"An account with this email already exists. Please sign in.\"}", 0);
        return;
    }
    if (new_user_id <= 0) {
        send_json(fd, 500, "Internal Server Error", "{\"error\":\"Unable to create account.\"}", 0);
        return;
    }

    char token[65];
    if (!create_session_token(new_user_id, token)) {
        send_json(fd, 500, "Internal Server Error", "{\"error\":\"Unable to create session.\"}", 0);
        return;
    }

    AuthUser u;
    u.id = new_user_id;
    snprintf(u.uid, sizeof(u.uid), "%s", uid);
    snprintf(u.display_name, sizeof(u.display_name), "%s", display_name);
    snprintf(u.email, sizeof(u.email), "%s", email);
    u.default_phone[0] = '\0';
    snprintf(u.role, sizeof(u.role), "rider");

    char user_json[1024];
    format_user_json(&u, user_json, sizeof(user_json));
    char resp[1408];
    snprintf(resp, sizeof(resp), "{\"user\":%s,\"token\":\"%s\"}", user_json, token);

    char cookie_hdr[256];
    snprintf(
        cookie_hdr,
        sizeof(cookie_hdr),
        "Set-Cookie: %s=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=1209600\r\n",
        SESSION_COOKIE_NAME,
        token
    );
    send_json_with_headers(fd, 201, "Created", cookie_hdr, resp, 0);
}

static void handle_auth_login(int fd, const char *body) {
    char email[180] = "";
    char password[128] = "";
    json_get_string(body, "email", email, sizeof(email));
    json_get_string(body, "password", password, sizeof(password));
    trim_whitespace(email);
    lowercase_str(email);

    if (!*email || !*password) {
        send_json(fd, 400, "Bad Request", "{\"error\":\"Email and password are required.\"}", 0);
        return;
    }

    AuthUser u;
    char stored_hash[65] = "";
    char stored_salt[65] = "";
    int found = 0;

    pthread_mutex_lock(&db_mutex);
    sqlite3_stmt *stmt = NULL;
    const char *sql =
        "SELECT id, uid, display_name, email, password_hash, salt, default_phone, role "
        "FROM users WHERE email = ? LIMIT 1;";
    if (sq.prepare_v2(db, sql, -1, &stmt, NULL) == SQLITE_OK) {
        sq.bind_text(stmt, 1, email, -1, SQLITE_TRANSIENT);
        if (sq.step(stmt) == SQLITE_ROW) {
            u.id = sq.column_int64(stmt, 0);
            snprintf(u.uid, sizeof(u.uid), "%s", (const char *)sq.column_text(stmt, 1));
            snprintf(u.display_name, sizeof(u.display_name), "%s", (const char *)sq.column_text(stmt, 2));
            snprintf(u.email, sizeof(u.email), "%s", (const char *)sq.column_text(stmt, 3));
            snprintf(stored_hash, sizeof(stored_hash), "%s", (const char *)sq.column_text(stmt, 4));
            snprintf(stored_salt, sizeof(stored_salt), "%s", (const char *)sq.column_text(stmt, 5));
            const unsigned char *ph = sq.column_text(stmt, 6);
            snprintf(u.default_phone, sizeof(u.default_phone), "%s", ph ? (const char *)ph : "");
            snprintf(u.role, sizeof(u.role), "%s", (const char *)sq.column_text(stmt, 7));
            found = 1;
        }
        sq.finalize(stmt);
    }
    pthread_mutex_unlock(&db_mutex);

    if (!found) {
        send_json(fd, 401, "Unauthorized", "{\"error\":\"Invalid email or password.\"}", 0);
        return;
    }

    char candidate_hash[65];
    hash_password_salted(stored_salt, password, candidate_hash);
    if (!constant_time_equal(stored_hash, candidate_hash)) {
        send_json(fd, 401, "Unauthorized", "{\"error\":\"Invalid email or password.\"}", 0);
        return;
    }

    char token[65];
    if (!create_session_token(u.id, token)) {
        send_json(fd, 500, "Internal Server Error", "{\"error\":\"Unable to create session.\"}", 0);
        return;
    }

    char user_json[1024];
    format_user_json(&u, user_json, sizeof(user_json));
    char resp[1408];
    snprintf(resp, sizeof(resp), "{\"user\":%s,\"token\":\"%s\"}", user_json, token);

    char cookie_hdr[256];
    snprintf(
        cookie_hdr,
        sizeof(cookie_hdr),
        "Set-Cookie: %s=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=1209600\r\n",
        SESSION_COOKIE_NAME,
        token
    );
    send_json_with_headers(fd, 200, "OK", cookie_hdr, resp, 0);
}

static void handle_auth_me(int fd, const char *raw_headers, int head_only) {
    AuthUser u;
    if (!authenticate_request(raw_headers, &u)) {
        send_json(fd, 401, "Unauthorized", "{\"user\":null}", head_only);
        return;
    }
    char user_json[1024];
    format_user_json(&u, user_json, sizeof(user_json));
    char resp[1280];
    snprintf(resp, sizeof(resp), "{\"user\":%s}", user_json);
    send_json(fd, 200, "OK", resp, head_only);
}

static void handle_auth_logout(int fd, const char *raw_headers) {
    char token[128] = "";
    if (extract_session_token(raw_headers, token, sizeof(token))) {
        pthread_mutex_lock(&db_mutex);
        sqlite3_stmt *stmt = NULL;
        if (sq.prepare_v2(db, "DELETE FROM sessions WHERE token = ?;", -1, &stmt, NULL) == SQLITE_OK) {
            sq.bind_text(stmt, 1, token, -1, SQLITE_TRANSIENT);
            sq.step(stmt);
            sq.finalize(stmt);
        }
        pthread_mutex_unlock(&db_mutex);
    }

    char cookie_hdr[256];
    snprintf(
        cookie_hdr,
        sizeof(cookie_hdr),
        "Set-Cookie: %s=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0\r\n",
        SESSION_COOKIE_NAME
    );
    send_json_with_headers(fd, 200, "OK", cookie_hdr, "{\"ok\":true}", 0);
}

/* ── Bookings & Profile SQL API Handlers ─────────────────────────────── */

static void handle_list_bookings(int fd, const char *raw_headers, int head_only) {
    AuthUser u;
    if (!authenticate_request(raw_headers, &u)) {
        send_json(fd, 401, "Unauthorized", "{\"error\":\"Authentication required\"}", head_only);
        return;
    }

    pthread_mutex_lock(&db_mutex);
    size_t cap = 8192;
    char *buf = malloc(cap);
    if (!buf) {
        pthread_mutex_unlock(&db_mutex);
        send_json(fd, 500, "Internal Server Error", "{\"error\":\"Out of memory\"}", head_only);
        return;
    }

    size_t len = (size_t)snprintf(buf, cap, "{\"bookings\":[");
    sqlite3_stmt *stmt = NULL;
    const char *sql =
        "SELECT id, booking_code, passenger_name, passenger_phone, vehicle, "
        "pickup_lat, pickup_lng, pickup_label, dest_lat, dest_lng, dest_label, "
        "distance_km, duration_min, base_fare, per_km_rate, fare_inr, "
        "driver_name, driver_phone, plate_number, status, created_at, updated_at "
        "FROM bookings WHERE user_id = ? ORDER BY id DESC;";

    int idx = 0;
    if (sq.prepare_v2(db, sql, -1, &stmt, NULL) == SQLITE_OK) {
        sq.bind_int64(stmt, 1, u.id);
        while (sq.step(stmt) == SQLITE_ROW) {
            int64_t bid = sq.column_int64(stmt, 0);
            const char *bcode = (const char *)sq.column_text(stmt, 1);
            const char *pname = (const char *)sq.column_text(stmt, 2);
            const char *pphone = (const char *)sq.column_text(stmt, 3);
            const char *veh = (const char *)sq.column_text(stmt, 4);
            double p_lat = sq.column_double(stmt, 5);
            double p_lng = sq.column_double(stmt, 6);
            const char *p_lbl = (const char *)sq.column_text(stmt, 7);
            double d_lat = sq.column_double(stmt, 8);
            double d_lng = sq.column_double(stmt, 9);
            const char *d_lbl = (const char *)sq.column_text(stmt, 10);
            double dist_km = sq.column_double(stmt, 11);
            double dur_min = sq.column_double(stmt, 12);
            double base_f = sq.column_double(stmt, 13);
            double per_km = sq.column_double(stmt, 14);
            double fare = sq.column_double(stmt, 15);
            const char *drv_name = (const char *)sq.column_text(stmt, 16);
            const char *drv_phone = (const char *)sq.column_text(stmt, 17);
            const char *plate = (const char *)sq.column_text(stmt, 18);
            const char *status = (const char *)sq.column_text(stmt, 19);
            const char *created = (const char *)sq.column_text(stmt, 20);
            const char *updated = (const char *)sq.column_text(stmt, 21);

            char e_code[48], e_pname[180], e_pphone[64], e_plbl[360], e_dlbl[360];
            char e_drv[180], e_dphone[64], e_plate[64], e_uid[128];
            json_escape(bcode, e_code, sizeof(e_code));
            json_escape(pname, e_pname, sizeof(e_pname));
            json_escape(pphone, e_pphone, sizeof(e_pphone));
            json_escape(p_lbl, e_plbl, sizeof(e_plbl));
            json_escape(d_lbl, e_dlbl, sizeof(e_dlbl));
            json_escape(drv_name, e_drv, sizeof(e_drv));
            json_escape(drv_phone, e_dphone, sizeof(e_dphone));
            json_escape(plate, e_plate, sizeof(e_plate));
            json_escape(u.uid, e_uid, sizeof(e_uid));

            char row[2048];
            int row_len = snprintf(
                row,
                sizeof(row),
                "%s{"
                "\"id\":\"%lld\","
                "\"userId\":\"%s\","
                "\"bookingCode\":\"%s\","
                "\"passengerName\":\"%s\","
                "\"passengerPhone\":\"%s\","
                "\"vehicle\":\"%s\","
                "\"pickupLat\":%.6f,"
                "\"pickupLng\":%.6f,"
                "\"pickupLabel\":\"%s\","
                "\"destLat\":%.6f,"
                "\"destLng\":%.6f,"
                "\"destLabel\":\"%s\","
                "\"distanceKm\":%.2f,"
                "\"durationMin\":%.2f,"
                "\"baseFare\":%.2f,"
                "\"perKmRate\":%.2f,"
                "\"fareInr\":%.2f,"
                "\"driverName\":\"%s\","
                "\"driverPhone\":\"%s\","
                "\"plateNumber\":\"%s\","
                "\"status\":\"%s\","
                "\"createdAt\":\"%s\","
                "\"updatedAt\":\"%s\""
                "}",
                idx > 0 ? "," : "",
                (long long)bid,
                e_uid,
                e_code,
                e_pname,
                e_pphone,
                veh ? veh : "auto",
                p_lat, p_lng, e_plbl,
                d_lat, d_lng, e_dlbl,
                dist_km, dur_min, base_f, per_km, fare,
                e_drv, e_dphone, e_plate,
                status ? status : "dispatched",
                created ? created : "",
                updated ? updated : ""
            );

            if (len + (size_t)row_len + 32 >= cap) {
                cap *= 2;
                char *grown = realloc(buf, cap);
                if (!grown) break;
                buf = grown;
            }
            memcpy(buf + len, row, (size_t)row_len);
            len += (size_t)row_len;
            idx++;
        }
        sq.finalize(stmt);
    }
    snprintf(buf + len, cap - len, "]}");
    pthread_mutex_unlock(&db_mutex);

    send_json(fd, 200, "OK", buf, head_only);
    free(buf);
}

static void handle_create_booking(int fd, const char *raw_headers, const char *body) {
    AuthUser u;
    if (!authenticate_request(raw_headers, &u)) {
        send_json(fd, 401, "Unauthorized", "{\"error\":\"Authentication required\"}", 0);
        return;
    }

    char booking_code[32] = "";
    char passenger_name[96] = "";
    char passenger_phone[32] = "";
    char vehicle[16] = "";
    char pickup_label[180] = "";
    char dest_label[180] = "";
    char driver_name[96] = "";
    char driver_phone[32] = "";
    char plate_number[32] = "";
    double p_lat = 0, p_lng = 0, d_lat = 0, d_lng = 0;
    double dist_km = 0, dur_min = 0, base_f = 0, per_km = 0, fare = 0;

    json_get_string(body, "bookingCode", booking_code, sizeof(booking_code));
    json_get_string(body, "passengerName", passenger_name, sizeof(passenger_name));
    json_get_string(body, "passengerPhone", passenger_phone, sizeof(passenger_phone));
    json_get_string(body, "vehicle", vehicle, sizeof(vehicle));
    json_get_string(body, "pickupLabel", pickup_label, sizeof(pickup_label));
    json_get_string(body, "destLabel", dest_label, sizeof(dest_label));
    json_get_string(body, "driverName", driver_name, sizeof(driver_name));
    json_get_string(body, "driverPhone", driver_phone, sizeof(driver_phone));
    json_get_string(body, "plateNumber", plate_number, sizeof(plate_number));

    if (!json_get_double(body, "pickupLat", &p_lat) ||
        !json_get_double(body, "pickupLng", &p_lng) ||
        !json_get_double(body, "destLat", &d_lat) ||
        !json_get_double(body, "destLng", &d_lng) ||
        !json_get_double(body, "distanceKm", &dist_km) ||
        !json_get_double(body, "durationMin", &dur_min) ||
        !json_get_double(body, "baseFare", &base_f) ||
        !json_get_double(body, "perKmRate", &per_km) ||
        !json_get_double(body, "fareInr", &fare)) {
        send_json(fd, 400, "Bad Request", "{\"error\":\"Missing numeric booking fields.\"}", 0);
        return;
    }

    trim_whitespace(passenger_name);
    trim_whitespace(passenger_phone);
    lowercase_str(vehicle);

    if (!lookup_vehicle_rate(vehicle) || strlen(passenger_name) < 1 || strlen(passenger_phone) < 6 ||
        dist_km <= 0.0 || fare <= 0.0) {
        send_json(fd, 400, "Bad Request", "{\"error\":\"Invalid booking payload.\"}", 0);
        return;
    }

    if (!*booking_code) {
        snprintf(booking_code, sizeof(booking_code), "TB-%d", 100000 + (rand() % 899999));
    }

    int64_t new_id = 0;
    pthread_mutex_lock(&db_mutex);
    sqlite3_stmt *stmt = NULL;
    const char *sql =
        "INSERT INTO bookings ("
        "  user_id, booking_code, passenger_name, passenger_phone, vehicle,"
        "  pickup_lat, pickup_lng, pickup_label, dest_lat, dest_lng, dest_label,"
        "  distance_km, duration_min, base_fare, per_km_rate, fare_inr,"
        "  driver_name, driver_phone, plate_number, status"
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dispatched');";

    if (sq.prepare_v2(db, sql, -1, &stmt, NULL) == SQLITE_OK) {
        sq.bind_int64(stmt, 1, u.id);
        sq.bind_text(stmt, 2, booking_code, -1, SQLITE_TRANSIENT);
        sq.bind_text(stmt, 3, passenger_name, -1, SQLITE_TRANSIENT);
        sq.bind_text(stmt, 4, passenger_phone, -1, SQLITE_TRANSIENT);
        sq.bind_text(stmt, 5, vehicle, -1, SQLITE_TRANSIENT);
        sq.bind_double(stmt, 6, p_lat);
        sq.bind_double(stmt, 7, p_lng);
        sq.bind_text(stmt, 8, *pickup_label ? pickup_label : "Pickup Point", -1, SQLITE_TRANSIENT);
        sq.bind_double(stmt, 9, d_lat);
        sq.bind_double(stmt, 10, d_lng);
        sq.bind_text(stmt, 11, *dest_label ? dest_label : "Destination Point", -1, SQLITE_TRANSIENT);
        sq.bind_double(stmt, 12, dist_km);
        sq.bind_double(stmt, 13, dur_min);
        sq.bind_double(stmt, 14, base_f);
        sq.bind_double(stmt, 15, per_km);
        sq.bind_double(stmt, 16, fare);
        sq.bind_text(stmt, 17, driver_name, -1, SQLITE_TRANSIENT);
        sq.bind_text(stmt, 18, driver_phone, -1, SQLITE_TRANSIENT);
        sq.bind_text(stmt, 19, plate_number, -1, SQLITE_TRANSIENT);
        if (sq.step(stmt) == SQLITE_DONE) {
            new_id = sq.last_insert_rowid(db);
        }
        sq.finalize(stmt);
    }

    if (new_id > 0) {
        sqlite3_stmt *up_stmt = NULL;
        const char *up_sql =
            "UPDATE users SET display_name = ?, default_phone = ?, "
            "updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?;";
        if (sq.prepare_v2(db, up_sql, -1, &up_stmt, NULL) == SQLITE_OK) {
            sq.bind_text(up_stmt, 1, passenger_name, -1, SQLITE_TRANSIENT);
            sq.bind_text(up_stmt, 2, passenger_phone, -1, SQLITE_TRANSIENT);
            sq.bind_int64(up_stmt, 3, u.id);
            sq.step(up_stmt);
            sq.finalize(up_stmt);
        }
    }
    pthread_mutex_unlock(&db_mutex);

    if (new_id <= 0) {
        send_json(fd, 500, "Internal Server Error", "{\"error\":\"Failed to persist booking.\"}", 0);
        return;
    }

    char resp[128];
    snprintf(resp, sizeof(resp), "{\"id\":\"%lld\"}", (long long)new_id);
    send_json(fd, 201, "Created", resp, 0);
}

static void handle_update_booking_status(int fd, const char *raw_headers, const char *body) {
    AuthUser u;
    if (!authenticate_request(raw_headers, &u)) {
        send_json(fd, 401, "Unauthorized", "{\"error\":\"Authentication required\"}", 0);
        return;
    }

    char id_str[32] = "";
    char status[24] = "";
    json_get_string(body, "id", id_str, sizeof(id_str));
    json_get_string(body, "status", status, sizeof(status));

    int64_t bid = strtoll(id_str, NULL, 10);
    if (bid <= 0 || (strcmp(status, "completed") != 0 && strcmp(status, "cancelled") != 0)) {
        send_json(fd, 400, "Bad Request", "{\"error\":\"Invalid booking ID or status.\"}", 0);
        return;
    }

    int updated_rows = 0;
    pthread_mutex_lock(&db_mutex);
    sqlite3_stmt *stmt = NULL;
    const char *sql =
        "UPDATE bookings SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') "
        "WHERE id = ? AND user_id = ? AND status = 'dispatched';";
    if (sq.prepare_v2(db, sql, -1, &stmt, NULL) == SQLITE_OK) {
        sq.bind_text(stmt, 1, status, -1, SQLITE_TRANSIENT);
        sq.bind_int64(stmt, 2, bid);
        sq.bind_int64(stmt, 3, u.id);
        if (sq.step(stmt) == SQLITE_DONE) {
            updated_rows = sq.changes(db);
        }
        sq.finalize(stmt);
    }
    pthread_mutex_unlock(&db_mutex);

    if (updated_rows <= 0) {
        send_json(fd, 404, "Not Found", "{\"error\":\"Dispatched booking not found.\"}", 0);
        return;
    }
    send_json(fd, 200, "OK", "{\"ok\":true}", 0);
}

static void handle_delete_booking(int fd, const char *raw_headers, const char *body) {
    AuthUser u;
    if (!authenticate_request(raw_headers, &u)) {
        send_json(fd, 401, "Unauthorized", "{\"error\":\"Authentication required\"}", 0);
        return;
    }

    char id_str[32] = "";
    json_get_string(body, "id", id_str, sizeof(id_str));
    int64_t bid = strtoll(id_str, NULL, 10);
    if (bid <= 0) {
        send_json(fd, 400, "Bad Request", "{\"error\":\"Invalid booking ID.\"}", 0);
        return;
    }

    int deleted_rows = 0;
    pthread_mutex_lock(&db_mutex);
    sqlite3_stmt *stmt = NULL;
    const char *sql = "DELETE FROM bookings WHERE id = ? AND user_id = ?;";
    if (sq.prepare_v2(db, sql, -1, &stmt, NULL) == SQLITE_OK) {
        sq.bind_int64(stmt, 1, bid);
        sq.bind_int64(stmt, 2, u.id);
        if (sq.step(stmt) == SQLITE_DONE) {
            deleted_rows = sq.changes(db);
        }
        sq.finalize(stmt);
    }
    pthread_mutex_unlock(&db_mutex);

    if (deleted_rows <= 0) {
        send_json(fd, 404, "Not Found", "{\"error\":\"Booking not found.\"}", 0);
        return;
    }
    send_json(fd, 200, "OK", "{\"ok\":true}", 0);
}

/* ── Dispatch & Tariff API Handlers ──────────────────────────────────── */

static void handle_health(int fd, int head_only) {
    const char *payload = "{\"ok\":true,\"service\":\"taxibook-india\",\"runtime\":\"c-posix-sqlite\"}";
    send_json(fd, 200, "OK", payload, head_only);
}

static void handle_download_schema(int fd, int head_only) {
    FILE *fp = fopen("./schema.sql", "rb");
    if (!fp) {
        const char *msg = "Schema file not found.";
        send_http_response(fd, 404, "Not Found", "text/plain", NULL, msg, strlen(msg), head_only);
        return;
    }
    fseek(fp, 0, SEEK_END);
    long sz = ftell(fp);
    fseek(fp, 0, SEEK_SET);
    if (sz < 0) sz = 0;
    char *buf = malloc((size_t)sz + 1);
    if (!buf) {
        fclose(fp);
        send_http_response(fd, 500, "Internal Server Error", "text/plain", NULL, "OOM", 3, head_only);
        return;
    }
    size_t read_bytes = fread(buf, 1, (size_t)sz, fp);
    fclose(fp);
    send_http_response(
        fd,
        200,
        "OK",
        "application/sql; charset=utf-8",
        "Content-Disposition: attachment; filename=\"taxibook-schema.sql\"\r\nCache-Control: no-cache\r\n",
        buf,
        read_bytes,
        head_only
    );
    free(buf);
}

static void handle_drivers(int fd, int head_only) {
    char buf[8192];
    int offset = 0;

    offset += snprintf(buf + offset, sizeof(buf) - (size_t)offset, "{\"rates\":{");
    for (int i = 0; i < NUM_TIERS; i++) {
        offset += snprintf(
            buf + offset,
            sizeof(buf) - (size_t)offset,
            "%s\"%s\":{\"base\":%.0f,\"perKm\":%.0f,\"label\":\"%s\",\"seats\":%d}",
            i > 0 ? "," : "",
            RATE_TABLE[i].key,
            RATE_TABLE[i].base_fare,
            RATE_TABLE[i].per_km_rate,
            RATE_TABLE[i].label,
            RATE_TABLE[i].seats
        );
    }
    offset += snprintf(buf + offset, sizeof(buf) - (size_t)offset, "},\"drivers\":{");
    for (int t = 0; t < NUM_TIERS; t++) {
        offset += snprintf(
            buf + offset,
            sizeof(buf) - (size_t)offset,
            "%s\"%s\":[",
            t > 0 ? "," : "",
            RATE_TABLE[t].key
        );
        for (int d = 0; d < DRIVERS_PER_TIER; d++) {
            offset += snprintf(
                buf + offset,
                sizeof(buf) - (size_t)offset,
                "%s{\"name\":\"%s\",\"phone\":\"%s\",\"plate\":\"%s\"}",
                d > 0 ? "," : "",
                DRIVER_POOLS[t][d].name,
                DRIVER_POOLS[t][d].phone,
                DRIVER_POOLS[t][d].plate
            );
        }
        offset += snprintf(buf + offset, sizeof(buf) - (size_t)offset, "]");
    }
    snprintf(buf + offset, sizeof(buf) - (size_t)offset, "}}");

    send_json(fd, 200, "OK", buf, head_only);
}

static void handle_calculate_fare(int fd, const char *query, int head_only) {
    char vehicle_buf[32] = "auto";
    char s_lat_buf[64] = "", s_lng_buf[64] = "", e_lat_buf[64] = "", e_lng_buf[64] = "";
    char dist_buf[64] = "";

    get_query_param(query, "vehicle", vehicle_buf, sizeof(vehicle_buf));
    lowercase_str(vehicle_buf);

    const VehicleRate *rate = lookup_vehicle_rate(vehicle_buf);
    if (!rate) {
        send_json(fd, 400, "Bad Request", "{\"error\":\"Invalid vehicle tier.\"}", head_only);
        return;
    }

    if (!get_query_param(query, "start_lat", s_lat_buf, sizeof(s_lat_buf)) ||
        !get_query_param(query, "start_lng", s_lng_buf, sizeof(s_lng_buf)) ||
        !get_query_param(query, "end_lat", e_lat_buf, sizeof(e_lat_buf)) ||
        !get_query_param(query, "end_lng", e_lng_buf, sizeof(e_lng_buf))) {
        send_json(fd, 400, "Bad Request", "{\"error\":\"Missing coordinates.\"}", head_only);
        return;
    }

    double start_lat = 0, start_lng = 0, end_lat = 0, end_lng = 0;
    if (!parse_double_strict(s_lat_buf, &start_lat) ||
        !parse_double_strict(s_lng_buf, &start_lng) ||
        !parse_double_strict(e_lat_buf, &end_lat) ||
        !parse_double_strict(e_lng_buf, &end_lng)) {
        send_json(fd, 400, "Bad Request", "{\"error\":\"Invalid coordinates.\"}", head_only);
        return;
    }

    double override_dist = 0.0;
    if (get_query_param(query, "distance_km", dist_buf, sizeof(dist_buf))) {
        if (!parse_double_strict(dist_buf, &override_dist) || override_dist <= 0.0) {
            override_dist = 0.0;
        }
    }

    RideRequest req;
    req.start_lat = start_lat;
    req.start_lng = start_lng;
    req.end_lat = end_lat;
    req.end_lng = end_lng;
    req.override_distance_km = override_dist;
    snprintf(req.vehicle, sizeof(req.vehicle), "%s", rate->key);

    pthread_mutex_lock(&db_mutex);
    enqueue_request(&req);
    RideRequest dequeued;
    if (!dequeue_request(&dequeued)) dequeued = req;

    double raw_dist = dequeued.override_distance_km > 0.0
                          ? dequeued.override_distance_km
                          : haversine_km(
                                dequeued.start_lat,
                                dequeued.start_lng,
                                dequeued.end_lat,
                                dequeued.end_lng
                            );
    double distance_km = round_two(raw_dist);
    if (distance_km < 0.1) distance_km = 0.1;

    double fare_inr = round_two(rate->base_fare + rate->per_km_rate * distance_km);
    int driver_idx = rand() % DRIVERS_PER_TIER;
    const Driver *driver = &DRIVER_POOLS[rate->tier_index][driver_idx];
    int code_num = 100000 + (rand() % 899999);
    pthread_mutex_unlock(&db_mutex);

    double bike_fare = round_two(RATE_TABLE[0].base_fare + RATE_TABLE[0].per_km_rate * distance_km);
    double auto_fare = round_two(RATE_TABLE[1].base_fare + RATE_TABLE[1].per_km_rate * distance_km);
    double car_fare  = round_two(RATE_TABLE[2].base_fare + RATE_TABLE[2].per_km_rate * distance_km);

    char json[2048];
    snprintf(
        json,
        sizeof(json),
        "{"
        "\"booking_code\":\"TB-%d\","
        "\"distance_km\":%.2f,"
        "\"fare_inr\":%.2f,"
        "\"base_fare\":%.2f,"
        "\"per_km_rate\":%.2f,"
        "\"vehicle\":\"%s\","
        "\"driver_name\":\"%s\","
        "\"driver_phone\":\"%s\","
        "\"plate_number\":\"%s\","
        "\"tier_quotes\":{"
        "\"bike\":{\"vehicle\":\"bike\",\"baseFare\":%.2f,\"perKmRate\":%.2f,\"fareInr\":%.2f},"
        "\"auto\":{\"vehicle\":\"auto\",\"baseFare\":%.2f,\"perKmRate\":%.2f,\"fareInr\":%.2f},"
        "\"car\":{\"vehicle\":\"car\",\"baseFare\":%.2f,\"perKmRate\":%.2f,\"fareInr\":%.2f}"
        "}"
        "}",
        code_num,
        distance_km,
        fare_inr,
        rate->base_fare,
        rate->per_km_rate,
        rate->key,
        driver->name,
        driver->phone,
        driver->plate,
        RATE_TABLE[0].base_fare, RATE_TABLE[0].per_km_rate, bike_fare,
        RATE_TABLE[1].base_fare, RATE_TABLE[1].per_km_rate, auto_fare,
        RATE_TABLE[2].base_fare, RATE_TABLE[2].per_km_rate, car_fare
    );

    send_json(fd, 200, "OK", json, head_only);
}

/* ── Static Frontend File Server (./dist) ────────────────────────────── */

static const char *get_mime_type(const char *filepath) {
    const char *dot = strrchr(filepath, '.');
    if (!dot) return "application/octet-stream";
    if (strcmp(dot, ".html") == 0) return "text/html; charset=utf-8";
    if (strcmp(dot, ".js") == 0 || strcmp(dot, ".mjs") == 0) return "application/javascript; charset=utf-8";
    if (strcmp(dot, ".css") == 0) return "text/css; charset=utf-8";
    if (strcmp(dot, ".json") == 0) return "application/json; charset=utf-8";
    if (strcmp(dot, ".svg") == 0) return "image/svg+xml";
    if (strcmp(dot, ".png") == 0) return "image/png";
    if (strcmp(dot, ".jpg") == 0 || strcmp(dot, ".jpeg") == 0) return "image/jpeg";
    if (strcmp(dot, ".webp") == 0) return "image/webp";
    if (strcmp(dot, ".ico") == 0) return "image/x-icon";
    if (strcmp(dot, ".woff2") == 0) return "font/woff2";
    if (strcmp(dot, ".woff") == 0) return "font/woff";
    return "application/octet-stream";
}

static int has_path_traversal(const char *path) {
    return strstr(path, "..") != NULL;
}

static void serve_file_from_dist(int fd, const char *req_path, int head_only) {
    if (has_path_traversal(req_path)) {
        send_http_response(fd, 403, "Forbidden", "text/plain", NULL, "Forbidden", 9, head_only);
        return;
    }

    char clean_path[1024];
    url_decode(req_path, clean_path, sizeof(clean_path));
    if (has_path_traversal(clean_path)) {
        send_http_response(fd, 403, "Forbidden", "text/plain", NULL, "Forbidden", 9, head_only);
        return;
    }

    char full_path[1280];
    if (strcmp(clean_path, "/") == 0) {
        snprintf(full_path, sizeof(full_path), "%s/index.html", DIST_ROOT);
    } else {
        snprintf(full_path, sizeof(full_path), "%s%s", DIST_ROOT, clean_path);
    }

    struct stat st;
    if (stat(full_path, &st) != 0 || S_ISDIR(st.st_mode)) {
        snprintf(full_path, sizeof(full_path), "%s/index.html", DIST_ROOT);
        if (stat(full_path, &st) != 0 || S_ISDIR(st.st_mode)) {
            const char *msg = "Frontend build not found. Run npm run build first.";
            send_http_response(fd, 404, "Not Found", "text/plain", NULL, msg, strlen(msg), head_only);
            return;
        }
    }

    FILE *fp = fopen(full_path, "rb");
    if (!fp) {
        const char *msg = "Unable to open asset.";
        send_http_response(fd, 500, "Internal Server Error", "text/plain", NULL, msg, strlen(msg), head_only);
        return;
    }

    size_t file_size = (size_t)st.st_size;
    char *data = malloc(file_size > 0 ? file_size : 1);
    if (!data) {
        fclose(fp);
        send_http_response(fd, 500, "Internal Server Error", "text/plain", NULL, "OOM", 3, head_only);
        return;
    }

    size_t read_bytes = fread(data, 1, file_size, fp);
    fclose(fp);

    const char *mime = get_mime_type(full_path);
    const char *extra = strstr(full_path, ".html") != NULL
                            ? "Cache-Control: no-cache\r\n"
                            : "Cache-Control: public, max-age=3600\r\n";

    send_http_response(fd, 200, "OK", mime, extra, data, read_bytes, head_only);
    free(data);
}

/* ── HTTP Request Router & Thread Worker ─────────────────────────────── */

static void *handle_client(void *arg) {
    int client_fd = *(int *)arg;
    free(arg);

    char *buffer = malloc(REQ_BUF_SIZE);
    if (!buffer) {
        close(client_fd);
        return NULL;
    }

    ssize_t total_read = 0;
    char *header_end = NULL;
    while (total_read < REQ_BUF_SIZE - 1) {
        ssize_t n = recv(client_fd, buffer + total_read, (size_t)(REQ_BUF_SIZE - 1 - total_read), 0);
        if (n <= 0) break;
        total_read += n;
        buffer[total_read] = '\0';
        header_end = strstr(buffer, "\r\n\r\n");
        if (header_end) break;
    }

    if (total_read <= 0 || !header_end) {
        free(buffer);
        close(client_fd);
        return NULL;
    }

    *header_end = '\0';
    const char *raw_headers = buffer;
    char *body_start = header_end + 4;
    size_t header_bytes = (size_t)(body_start - buffer);
    size_t body_have = (size_t)total_read - header_bytes;

    char cl_buf[32] = "";
    size_t content_length = 0;
    if (extract_header_value(raw_headers, "Content-Length", cl_buf, sizeof(cl_buf))) {
        long cl = strtol(cl_buf, NULL, 10);
        if (cl > 0 && cl < REQ_BUF_SIZE - (long)header_bytes - 1) {
            content_length = (size_t)cl;
        }
    }

    while (body_have < content_length && total_read < REQ_BUF_SIZE - 1) {
        ssize_t n = recv(client_fd, buffer + total_read, content_length - body_have, 0);
        if (n <= 0) break;
        total_read += n;
        body_have += (size_t)n;
    }
    buffer[header_bytes + body_have] = '\0';

    char method[16] = "";
    char raw_target[2048] = "";
    if (sscanf(raw_headers, "%15s %2047s", method, raw_target) != 2) {
        send_json(client_fd, 400, "Bad Request", "{\"error\":\"Malformed HTTP request\"}", 0);
        free(buffer);
        close(client_fd);
        return NULL;
    }

    if (strcmp(method, "OPTIONS") == 0) {
        send_http_response(
            client_fd,
            204,
            "No Content",
            "text/plain",
            "Access-Control-Allow-Methods: GET, POST, HEAD, OPTIONS\r\n"
            "Access-Control-Allow-Headers: Content-Type, Authorization\r\n",
            "",
            0,
            1
        );
        free(buffer);
        close(client_fd);
        return NULL;
    }

    char path_only[1024] = "";
    char query_only[1024] = "";
    const char *qmark = strchr(raw_target, '?');
    if (qmark) {
        size_t plen = (size_t)(qmark - raw_target);
        if (plen >= sizeof(path_only)) plen = sizeof(path_only) - 1;
        memcpy(path_only, raw_target, plen);
        path_only[plen] = '\0';
        snprintf(query_only, sizeof(query_only), "%s", qmark + 1);
    } else {
        snprintf(path_only, sizeof(path_only), "%s", raw_target);
    }

    int head_only = (strcmp(method, "HEAD") == 0);
    int is_get_or_head = (strcmp(method, "GET") == 0 || head_only);
    int is_post = (strcmp(method, "POST") == 0);

    if (strcmp(path_only, "/api/health") == 0 && is_get_or_head) {
        handle_health(client_fd, head_only);
    } else if ((strcmp(path_only, "/api/schema.sql") == 0 || strcmp(path_only, "/schema.sql") == 0) && is_get_or_head) {
        handle_download_schema(client_fd, head_only);
    } else if (strcmp(path_only, "/api/drivers") == 0 && is_get_or_head) {
        handle_drivers(client_fd, head_only);
    } else if ((strcmp(path_only, "/api/calculate-fare") == 0 || strcmp(path_only, "/calculate-fare") == 0) && is_get_or_head) {
        handle_calculate_fare(client_fd, query_only, head_only);
    } else if (strcmp(path_only, "/api/auth/register") == 0 && is_post) {
        handle_auth_register(client_fd, body_start);
    } else if (strcmp(path_only, "/api/auth/login") == 0 && is_post) {
        handle_auth_login(client_fd, body_start);
    } else if (strcmp(path_only, "/api/auth/me") == 0 && is_get_or_head) {
        handle_auth_me(client_fd, raw_headers, head_only);
    } else if (strcmp(path_only, "/api/auth/logout") == 0 && is_post) {
        handle_auth_logout(client_fd, raw_headers);
    } else if (strcmp(path_only, "/api/bookings") == 0 && is_get_or_head) {
        handle_list_bookings(client_fd, raw_headers, head_only);
    } else if (strcmp(path_only, "/api/bookings") == 0 && is_post) {
        handle_create_booking(client_fd, raw_headers, body_start);
    } else if (strcmp(path_only, "/api/bookings/status") == 0 && is_post) {
        handle_update_booking_status(client_fd, raw_headers, body_start);
    } else if (strcmp(path_only, "/api/bookings/delete") == 0 && is_post) {
        handle_delete_booking(client_fd, raw_headers, body_start);
    } else if (strncmp(path_only, "/api/", 5) == 0) {
        send_json(client_fd, 404, "Not Found", "{\"error\":\"Endpoint not found\"}", head_only);
    } else if (is_get_or_head) {
        serve_file_from_dist(client_fd, path_only, head_only);
    } else {
        send_json(client_fd, 405, "Method Not Allowed", "{\"error\":\"Method not allowed\"}", 0);
    }

    free(buffer);
    close(client_fd);
    return NULL;
}

/* ── Main Server Entrypoint ──────────────────────────────────────────── */

int main(void) {
    signal(SIGPIPE, SIG_IGN);
    srand((unsigned int)time(NULL));
    init_rate_hash_table();

    if (!init_database()) {
        fprintf(stderr, "Database initialization failed. Exiting.\n");
        return EXIT_FAILURE;
    }

    int port = DEFAULT_PORT;
    const char *env_port = getenv("PORT");
    if (env_port && *env_port) {
        int parsed = atoi(env_port);
        if (parsed > 0 && parsed <= 65535) port = parsed;
    }

    int server_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (server_fd < 0) {
        perror("socket");
        return EXIT_FAILURE;
    }

    int opt = 1;
    setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons((uint16_t)port);

    if (bind(server_fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("bind");
        close(server_fd);
        return EXIT_FAILURE;
    }

    if (listen(server_fd, 64) < 0) {
        perror("listen");
        close(server_fd);
        return EXIT_FAILURE;
    }

    printf("TaxiBook India C + SQLite backend listening on http://0.0.0.0:%d\n", port);
    fflush(stdout);

    while (1) {
        struct sockaddr_in client_addr;
        socklen_t client_len = sizeof(client_addr);
        int client_fd = accept(server_fd, (struct sockaddr *)&client_addr, &client_len);
        if (client_fd < 0) {
            if (errno == EINTR) continue;
            perror("accept");
            continue;
        }

        int *fd_ptr = malloc(sizeof(int));
        if (!fd_ptr) {
            close(client_fd);
            continue;
        }
        *fd_ptr = client_fd;

        pthread_t tid;
        pthread_attr_t attr;
        pthread_attr_init(&attr);
        pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
        if (pthread_create(&tid, &attr, handle_client, fd_ptr) != 0) {
            free(fd_ptr);
            close(client_fd);
        }
        pthread_attr_destroy(&attr);
    }

    sq.close(db);
    close(server_fd);
    return EXIT_SUCCESS;
}
