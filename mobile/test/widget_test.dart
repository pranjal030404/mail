import 'package:flutter_test/flutter_test.dart';
import 'package:arthvex_mail/api.dart';
import 'package:arthvex_mail/main.dart';

void main() {
  testWidgets('shows login when no session', (tester) async {
    await tester.pumpWidget(ArthvexApp(Api()));
    expect(find.text('Sign in to your mailbox'), findsOneWidget);
  });
}
