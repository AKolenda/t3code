# Mobile notifications

Sign in to T3 Connect, link your environments, and enable **Device Notifications** in Settings to receive alerts when an agent finishes, fails, needs approval, or asks for input. Tap a notification to open its thread. Your environment must have agent activity publishing enabled.

Individual alerts show the thread title, followed by the status and project name: **Approval: Project**, **Input: Project**, **Done: Project**, or **Failed: Project**.

With ongoing activity enabled, several threads changing in the same update can produce one alert: **2 agents need attention** or **2 agents finished**, followed by their thread titles. On Android, tapping a grouped alert opens the priority thread: one needing attention first, then a failed thread, then other work.

The mobile app suppresses ordinary alert notifications while it is in the foreground. Ongoing activity continues to update. Viewing a thread on another device does not silence your phone's alerts.

On Android 7.0 and newer, **Ongoing Agent Activity** shows the active count and how many agents need attention. Expand the notification to see up to five threads, including each project and status. Threads needing attention appear first, followed by failures and other work. Android 16 and newer can promote it to a Live Update on the lock screen and status bar. Android controls whether promotion is available and enabled. Other devices show a regular ongoing notification.

You can dismiss the ongoing notification without disabling completion and attention alerts. Disabling Ongoing Agent Activity removes the current activity notification. Signing out clears T3's notifications from the device. Finished results stay visible for up to 15 minutes with an **Agent work completed** or **Agent work failed** heading. A failure takes priority when results are mixed. Dismissing a run keeps its finished card dismissed; new work can show a new card.

Reopening the app preserves existing notifications and refreshes activity from T3 Connect. If an environment stops sending updates, working states expire after two hours and approval/input states after 24 hours.

Android 7 uses a system alarm to remove expired cards; battery-saving modes can delay removal. Android 8 and newer use the system notification timeout.

On iOS, enable **Live Activity Updates** to show agent status using Apple Live Activities.

Notification permission and Android notification channels are controlled in system Settings. Background delivery uses T3 Connect and the platform's push service; Android requires Google Play services. The mobile app does not need to maintain a connection to your environment. Force-stopping the Android app in system Settings prevents push delivery until you open it again.
