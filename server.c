/*
 * TaxiBook India — Pure C Dispatch & Static Frontend Server (POSIX Sockets + pthreads)
 *
 * Implements the dispatch backend in pure C while Supabase handles auth & persistence:
 *   1. Core ADS Dispatch Structures:
 *        - Struct Arrays      : Ground-truth Indian pricing & driver pools
 *        - Hash Table (djb2)  : O(1) vehicle tier lookup
 *        - FIFO Queue         : Ride dispatch request pipeline
 *   2. Static File Server:
 *        - Serves the built Vite React frontend from ./dist (with SPA fallback)
 *        - Serves ./schema.sql at /api/schema.sql for Supabase SQL Editor setup
 *
 * Compile: gcc -O2 -Wall -Wextra -pthread -o server_bin server.c -lm
 * Run:     ./server_bin
 */

#define _POSIX_C_SOURCE 200809L

#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
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

static pthread_mutex_t dispatch_mutex = PTHREAD_MUTEX_INITIALIZER;

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

/* ── Geodesic & URL Helpers ──────────────────────────────────────────── */

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

static void lowercase_str(char *str) {
    for (size_t i = 0; str[i]; i++) str[i] = (char)tolower((unsigned char)str[i]);
}

/* ── HTTP Socket Helpers ─────────────────────────────────────────────── */

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

/* ── Dispatch & Schema API Handlers ──────────────────────────────────── */

static void handle_health(int fd, int head_only) {
    const char *payload = "{\"ok\":true,\"service\":\"taxibook-india\",\"runtime\":\"c-posix\",\"database\":\"supabase\"}";
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
        "Content-Disposition: attachment; filename=\"taxibook-supabase-schema.sql\"\r\nCache-Control: no-cache\r\n",
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

    pthread_mutex_lock(&dispatch_mutex);
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
    pthread_mutex_unlock(&dispatch_mutex);

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

    if (strcmp(path_only, "/api/health") == 0 && is_get_or_head) {
        handle_health(client_fd, head_only);
    } else if ((strcmp(path_only, "/api/schema.sql") == 0 || strcmp(path_only, "/schema.sql") == 0) && is_get_or_head) {
        handle_download_schema(client_fd, head_only);
    } else if (strcmp(path_only, "/api/drivers") == 0 && is_get_or_head) {
        handle_drivers(client_fd, head_only);
    } else if ((strcmp(path_only, "/api/calculate-fare") == 0 || strcmp(path_only, "/calculate-fare") == 0) && is_get_or_head) {
        handle_calculate_fare(client_fd, query_only, head_only);
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

    printf("TaxiBook India C dispatch + Supabase frontend server listening on http://0.0.0.0:%d\n", port);
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

    close(server_fd);
    return EXIT_SUCCESS;
}
