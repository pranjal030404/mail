import 'package:flutter/material.dart';
import 'api.dart';

final navKey = GlobalKey<NavigatorState>();

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final api = Api();
  await api.load();
  api.onSessionExpired = () => navKey.currentState?.pushAndRemoveUntil(MaterialPageRoute(builder: (_) => LoginPage(api)), (_) => false);
  runApp(ArthvexApp(api));
}

class ArthvexApp extends StatelessWidget {
  final Api api;
  const ArthvexApp(this.api, {super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
        navigatorKey: navKey,
        title: 'ARTHVEX Mail',
        debugShowCheckedModeBanner: false,
        theme: ThemeData(colorSchemeSeed: const Color(0xFF1F4FD8), useMaterial3: true),
        darkTheme: ThemeData(colorSchemeSeed: const Color(0xFF1F4FD8), brightness: Brightness.dark, useMaterial3: true),
        home: api.token != null ? BoxesPage(api) : LoginPage(api),
      );
}

void _goRoot(BuildContext c, Widget w) => Navigator.of(c).pushAndRemoveUntil(MaterialPageRoute(builder: (_) => w), (_) => false);

class LoginPage extends StatefulWidget {
  final Api api;
  const LoginPage(this.api, {super.key});
  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  late final server = TextEditingController(text: widget.api.server);
  final email = TextEditingController(), password = TextEditingController(), code = TextEditingController();
  String? error;
  bool busy = false, mfa = false;

  Future<void> _submit() async {
    setState(() { busy = true; error = null; });
    try {
      if (!mfa) {
        await widget.api.setServer(server.text);
        mfa = await widget.api.login(email.text, password.text);
      } else {
        await widget.api.verifyMfa(code.text);
      }
      if (!mfa && mounted) _goRoot(context, BoxesPage(widget.api));
    } on ApiException catch (e) {
      error = e.message;
    }
    if (mounted) setState(() => busy = false);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        body: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Text('ARTHVEX Mail', style: Theme.of(context).textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.bold)),
                const SizedBox(height: 4),
                const Text('Sign in to your mailbox'),
                const SizedBox(height: 24),
                if (!mfa) ...[
                  TextField(controller: server, keyboardType: TextInputType.url, decoration: const InputDecoration(labelText: 'Server', border: OutlineInputBorder())),
                  const SizedBox(height: 12),
                  TextField(controller: email, keyboardType: TextInputType.emailAddress, autofillHints: const [AutofillHints.email], decoration: const InputDecoration(labelText: 'Email', border: OutlineInputBorder())),
                  const SizedBox(height: 12),
                  TextField(controller: password, obscureText: true, autofillHints: const [AutofillHints.password], decoration: const InputDecoration(labelText: 'Password', border: OutlineInputBorder())),
                ] else
                  TextField(controller: code, decoration: const InputDecoration(labelText: 'Two-factor or recovery code', border: OutlineInputBorder())),
                if (error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(error!, style: TextStyle(color: Theme.of(context).colorScheme.error))),
                const SizedBox(height: 16),
                FilledButton(onPressed: busy ? null : _submit, child: Text(busy ? 'Please wait…' : mfa ? 'Verify' : 'Sign in')),
              ]),
            ),
          ),
        ),
      );
}

class BoxesPage extends StatefulWidget {
  final Api api;
  const BoxesPage(this.api, {super.key});
  @override
  State<BoxesPage> createState() => _BoxesPageState();
}

class _BoxesPageState extends State<BoxesPage> {
  late Future<List<Mailbox>> future = widget.api.mailboxes();

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Mailboxes'), actions: [
          TextButton(onPressed: () async { await widget.api.logout(); if (context.mounted) _goRoot(context, LoginPage(widget.api)); }, child: const Text('Sign out')),
        ]),
        body: FutureBuilder<List<Mailbox>>(
          future: future,
          builder: (c, s) {
            if (s.hasError) {
              final e = s.error;
              if (e is ApiException && e.status == 401) WidgetsBinding.instance.addPostFrameCallback((_) => _goRoot(context, LoginPage(widget.api)));
              return Padding(padding: const EdgeInsets.all(16), child: Text('$e', style: TextStyle(color: Theme.of(c).colorScheme.error)));
            }
            if (!s.hasData) return const Center(child: CircularProgressIndicator());
            if (s.data!.isEmpty) return const Padding(padding: EdgeInsets.all(16), child: Text('No mailbox is assigned to this account yet. Ask your administrator.'));
            return ListView(children: [
              for (final b in s.data!)
                ListTile(title: Text(b.address), subtitle: Text(b.displayName ?? b.status), trailing: const Icon(Icons.chevron_right),
                    onTap: () => Navigator.of(c).push(MaterialPageRoute(builder: (_) => InboxPage(widget.api, b)))),
            ]);
          },
        ),
      );
}

class InboxPage extends StatefulWidget {
  final Api api;
  final Mailbox box;
  const InboxPage(this.api, this.box, {super.key});
  @override
  State<InboxPage> createState() => _InboxPageState();
}

class _InboxPageState extends State<InboxPage> {
  List<Folder> folders = [];
  String? folderId;
  List<Msg>? messages;
  String? error;
  final search = TextEditingController();

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    try {
      folders = await widget.api.folders(widget.box);
      folderId = (folders.where((f) => f.role == 'inbox').firstOrNull ?? folders.firstOrNull)?.id;
      await _load();
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    }
  }

  Future<void> _load() async {
    if (folderId == null) return;
    try {
      final m = await widget.api.messages(widget.box, folderId, search.text);
      if (mounted) setState(() { messages = m; error = null; });
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: Text(widget.box.address, overflow: TextOverflow.ellipsis)),
        floatingActionButton: FloatingActionButton.extended(
          icon: const Icon(Icons.edit),
          label: const Text('Compose'),
          onPressed: () async { await Navigator.of(context).push(MaterialPageRoute(builder: (_) => ComposePage(widget.api, widget.box))); _load(); },
        ),
        body: Column(children: [
          SizedBox(
            height: 52,
            child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 12), children: [
              for (final f in folders)
                Padding(padding: const EdgeInsets.only(right: 8), child: ChoiceChip(
                  label: Text(f.unread > 0 ? '${f.name} (${f.unread})' : f.name),
                  selected: f.id == folderId,
                  onSelected: (_) { setState(() { folderId = f.id; messages = null; }); _load(); },
                )),
            ]),
          ),
          Padding(padding: const EdgeInsets.all(12), child: TextField(controller: search, textInputAction: TextInputAction.search, onSubmitted: (_) => _load(), decoration: const InputDecoration(hintText: 'Search', prefixIcon: Icon(Icons.search), border: OutlineInputBorder(), isDense: true))),
          if (error != null) Padding(padding: const EdgeInsets.all(12), child: Text(error!, style: TextStyle(color: Theme.of(context).colorScheme.error))),
          Expanded(
            child: messages == null
                ? (error == null ? const Center(child: CircularProgressIndicator()) : const SizedBox())
                : RefreshIndicator(
                    onRefresh: _load,
                    child: messages!.isEmpty
                        ? ListView(children: const [Padding(padding: EdgeInsets.all(24), child: Text('No messages.'))])
                        : ListView.separated(
                            itemCount: messages!.length,
                            separatorBuilder: (_, _) => const Divider(height: 1),
                            itemBuilder: (c, i) {
                              final m = messages![i];
                              final w = m.unread ? FontWeight.bold : FontWeight.normal;
                              return ListTile(
                                title: Text(m.from, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontWeight: w)),
                                subtitle: Text('${m.subject}\n${m.preview}', maxLines: 2, overflow: TextOverflow.ellipsis),
                                isThreeLine: true,
                                trailing: Column(mainAxisAlignment: MainAxisAlignment.center, children: [Text(m.receivedAt.length >= 10 ? m.receivedAt.substring(0, 10) : '', style: Theme.of(c).textTheme.labelSmall), if (m.hasAttachment) const Icon(Icons.attach_file, size: 16)]),
                                onTap: () async { await Navigator.of(c).push(MaterialPageRoute(builder: (_) => ReadPage(widget.api, widget.box, m.id))); _load(); },
                              );
                            },
                          ),
                  ),
          ),
        ]),
      );
}

class ReadPage extends StatefulWidget {
  final Api api;
  final Mailbox box;
  final String id;
  const ReadPage(this.api, this.box, this.id, {super.key});
  @override
  State<ReadPage> createState() => _ReadPageState();
}

class _ReadPageState extends State<ReadPage> {
  FullMsg? msg;
  String? error;

  @override
  void initState() {
    super.initState();
    () async {
      try {
        final m = await widget.api.message(widget.box, widget.id);
        if (m.summary.unread) await widget.api.setRead(widget.box, widget.id, true);
        if (mounted) setState(() => msg = m);
      } on ApiException catch (e) {
        if (mounted) setState(() => error = e.message);
      }
    }();
  }

  @override
  Widget build(BuildContext context) {
    final m = msg;
    return Scaffold(
      appBar: AppBar(title: const Text('Message'), actions: [
        if (m != null) ...[
          IconButton(
            tooltip: 'Reply',
            icon: const Icon(Icons.reply),
            onPressed: () {
              final s = m.summary.subject;
              final quoted = m.text.split('\n').map((l) => '> $l').join('\n');
              Navigator.of(context).push(MaterialPageRoute(builder: (_) => ComposePage(widget.api, widget.box, to: m.fromEmail, subject: s.toLowerCase().startsWith('re:') ? s : 'Re: $s', body: '\n\nOn ${m.summary.receivedAt}, ${m.fromEmail} wrote:\n$quoted')));
            },
          ),
          IconButton(
            tooltip: 'Delete',
            icon: const Icon(Icons.delete_outline),
            onPressed: () async {
              try { await widget.api.delete(widget.box, widget.id); if (context.mounted) Navigator.of(context).pop(); } on ApiException catch (e) { setState(() => error = e.message); }
            },
          ),
        ]
      ]),
      body: error != null
          ? Padding(padding: const EdgeInsets.all(16), child: Text(error!, style: TextStyle(color: Theme.of(context).colorScheme.error)))
          : m == null
              ? const Center(child: CircularProgressIndicator())
              : SingleChildScrollView(
                  padding: const EdgeInsets.all(16),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(m.summary.subject, style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.bold)),
                    const SizedBox(height: 8),
                    Text('From: ${m.fromEmail}'),
                    Text('To: ${m.summary.to}'),
                    if (m.cc.isNotEmpty) Text('Cc: ${m.cc}'),
                    Text(m.summary.receivedAt),
                    const Divider(height: 24),
                    SelectableText(m.text),
                    if (m.attachments.isNotEmpty) ...[
                      const Divider(height: 24),
                      const Text('Attachments', style: TextStyle(fontWeight: FontWeight.w600)),
                      for (final a in m.attachments) Text('• $a'),
                    ],
                  ]),
                ),
    );
  }
}

class ComposePage extends StatefulWidget {
  final Api api;
  final Mailbox box;
  final String to, subject, body;
  const ComposePage(this.api, this.box, {super.key, this.to = '', this.subject = '', this.body = ''});
  @override
  State<ComposePage> createState() => _ComposePageState();
}

class _ComposePageState extends State<ComposePage> {
  late final to = TextEditingController(text: widget.to), subject = TextEditingController(text: widget.subject), body = TextEditingController(text: widget.body);
  final cc = TextEditingController();
  String? error;
  bool busy = false;

  List<String> _split(String s) => s.split(RegExp(r'[,; ]+')).map((e) => e.trim()).where((e) => e.isNotEmpty).toList();

  Future<void> _send() async {
    setState(() { busy = true; error = null; });
    try {
      await widget.api.send(widget.box, _split(to.text), _split(cc.text), subject.text, body.text);
      if (mounted) Navigator.of(context).pop();
      return;
    } on ApiException catch (e) {
      error = e.message;
    }
    if (mounted) setState(() => busy = false);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('New message'), actions: [
          TextButton(onPressed: busy ? null : _send, child: Text(busy ? 'Sending…' : 'Send')),
        ]),
        body: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(children: [
            Align(alignment: Alignment.centerLeft, child: Text('From: ${widget.box.address}')),
            const SizedBox(height: 8),
            TextField(controller: to, keyboardType: TextInputType.emailAddress, decoration: const InputDecoration(labelText: 'To')),
            TextField(controller: cc, keyboardType: TextInputType.emailAddress, decoration: const InputDecoration(labelText: 'Cc')),
            TextField(controller: subject, decoration: const InputDecoration(labelText: 'Subject')),
            TextField(controller: body, minLines: 10, maxLines: null, keyboardType: TextInputType.multiline, decoration: const InputDecoration(labelText: 'Message', alignLabelWithHint: true)),
            if (error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(error!, style: TextStyle(color: Theme.of(context).colorScheme.error))),
          ]),
        ),
      );
}
