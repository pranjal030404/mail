import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

/// Compile-time default; override with --dart-define=API_BASE_URL=https://mail.yourdomain.com
const defaultServer = String.fromEnvironment('API_BASE_URL', defaultValue: 'https://mail.example.com');

class ApiException implements Exception {
  final int status;
  final String code;
  final String message;
  ApiException(this.status, this.code, this.message);
  @override
  String toString() => message;
}

class Mailbox {
  final String tenantId, id, address, status;
  final String? displayName;
  Mailbox(this.tenantId, this.id, this.address, this.displayName, this.status);
}

class Folder {
  final String id, name, role;
  final int unread;
  Folder(this.id, this.name, this.role, this.unread);
}

class Msg {
  final String id, from, to, subject, preview, receivedAt;
  final bool unread, hasAttachment;
  Msg(this.id, this.from, this.to, this.subject, this.preview, this.receivedAt, this.unread, this.hasAttachment);
}

class FullMsg {
  final Msg summary;
  final String fromEmail, cc, text;
  final List<String> attachments;
  FullMsg(this.summary, this.fromEmail, this.cc, this.text, this.attachments);
}

String _names(dynamic a) => ((a ?? []) as List).map((x) => ((x['name'] as String?)?.trim().isNotEmpty ?? false) ? x['name'] : x['email']).join(', ');
String _emails(dynamic a) => ((a ?? []) as List).map((x) => x['email']).join(', ');

Msg _summary(Map o) => Msg(o['id'], _names(o['from']), _names(o['to']), (o['subject'] as String?)?.trim().isNotEmpty == true ? o['subject'] : '(no subject)',
    o['preview'] ?? '', o['receivedAt'] ?? '', o['unread'] == true, o['hasAttachment'] == true);

class Api {
  static const _storage = FlutterSecureStorage();
  final http.Client _http = http.Client();
  String server = defaultServer;
  String? token;
  /// Called when the server rejects the session (expired/revoked) so the UI can return to sign-in.
  void Function()? onSessionExpired;

  Future<void> load() async {
    server = await _storage.read(key: 'server') ?? defaultServer;
    token = await _storage.read(key: 'token');
  }

  Future<void> _saveToken(String? t) async {
    token = t;
    if (t == null) {
      await _storage.delete(key: 'token');
    } else {
      await _storage.write(key: 'token', value: t);
    }
  }

  Future<void> setServer(String s) async {
    server = s.trim().replaceAll(RegExp(r'/+$'), '');
    await _storage.write(key: 'server', value: server);
  }

  Future<Map<String, dynamic>> _call(String method, String path, {Object? body}) async {
    if (!server.startsWith('https://')) throw ApiException(0, 'insecure', 'The server address must start with https://');
    final req = http.Request(method, Uri.parse('$server/api/v1$path'));
    req.headers.addAll({'X-Client': 'mobile', 'Accept': 'application/json', 'Content-Type': 'application/json', if (token != null) 'Authorization': 'Bearer $token'});
    if (body != null || method != 'GET') req.body = jsonEncode(body ?? {});
    try {
      final res = await http.Response.fromStream(await _http.send(req).timeout(const Duration(seconds: 60)));
      Map<String, dynamic> obj = {};
      try { obj = jsonDecode(res.body) as Map<String, dynamic>; } catch (_) {}
      if (res.statusCode >= 400) {
        final e = (obj['error'] ?? {}) as Map;
        if (res.statusCode == 401 && e['code'] != 'mfa_required' && path != '/auth/login') {
          await _saveToken(null);
          onSessionExpired?.call();
        }
        throw ApiException(res.statusCode, '${e['code'] ?? 'error'}', (e['message'] as String?) ?? 'Request failed (${res.statusCode}).');
      }
      return obj;
    } on ApiException {
      rethrow;
    } catch (_) {
      throw ApiException(0, 'network', 'Cannot reach the server. Check your connection.');
    }
  }

  /// Returns true when a two-factor code is still required.
  Future<bool> login(String email, String password) async {
    await _saveToken(null);
    final r = await _call('POST', '/auth/login', body: {'email': email.trim(), 'password': password});
    await _saveToken(r['token'] as String);
    return r['mfaRequired'] == true;
  }

  Future<void> verifyMfa(String code) => _call('POST', '/auth/mfa/verify', body: {'code': code.trim()});

  Future<void> logout() async {
    try { await _call('POST', '/auth/logout'); } catch (_) {}
    await _saveToken(null);
  }

  Future<List<Mailbox>> mailboxes() async {
    final me = await _call('GET', '/me');
    if (me['mfaPending'] == true) throw ApiException(401, 'mfa_required', 'Enter your two-factor code.');
    final out = <Mailbox>[];
    for (final m in (me['memberships'] ?? []) as List) {
      final r = await _call('GET', '/tenants/${m['tenantId']}/mailboxes?pageSize=100');
      for (final b in (r['mailboxes'] ?? []) as List) {
        if (b['status'] == 'active' || b['status'] == 'suspended') out.add(Mailbox(m['tenantId'], b['id'], b['address'], b['displayName'], b['status']));
      }
    }
    return out;
  }

  String _b(Mailbox m) => '/tenants/${m.tenantId}/mailboxes/${m.id}/webmail';

  Future<List<Folder>> folders(Mailbox m) async {
    final r = await _call('GET', '${_b(m)}/folders');
    return (r['folders'] as List).map((f) => Folder(f['id'], f['name'], f['role'], (f['unreadMessages'] ?? 0) as int)).toList();
  }

  Future<List<Msg>> messages(Mailbox m, String? folderId, String? q, {int page = 1}) async {
    final qs = {'page': '$page', 'pageSize': '30', 'folderId': ?folderId, if (q != null && q.trim().isNotEmpty) 'q': q.trim()};
    final r = await _call('GET', '${_b(m)}/messages?${Uri(queryParameters: qs).query}');
    return (r['messages'] as List).map((o) => _summary(o as Map)).toList();
  }

  Future<FullMsg> message(Mailbox m, String id) async {
    final o = await _call('GET', '${_b(m)}/messages/${Uri.encodeComponent(id)}');
    final att = ((o['attachments'] ?? []) as List).map((a) => '${a['name']} (${((a['size'] ?? 0) as num) ~/ 1024} KB)').toList();
    return FullMsg(_summary(o), _emails(o['from']), _names(o['cc']), (o['text'] ?? '') as String, att);
  }

  Future<void> setRead(Mailbox m, String id, bool read) => _call('PATCH', '${_b(m)}/messages/${Uri.encodeComponent(id)}', body: {'read': read});
  Future<void> delete(Mailbox m, String id) => _call('DELETE', '${_b(m)}/messages/${Uri.encodeComponent(id)}');

  Future<void> send(Mailbox m, List<String> to, List<String> cc, String subject, String text) =>
      _call('POST', '${_b(m)}/send', body: {'to': to, 'cc': cc, 'bcc': [], 'subject': subject, 'text': text});
}
