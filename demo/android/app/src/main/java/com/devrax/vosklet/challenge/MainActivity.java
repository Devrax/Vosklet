package com.devrax.vosklet.challenge;

import android.Manifest;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.util.Log;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
	private static final String TAG = "VoskletChallenge";

	@Override
	public void onCreate(Bundle savedInstanceState) {
		boolean debuggingEnabled = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
		WebView.setWebContentsDebuggingEnabled(debuggingEnabled);
		Log.i(TAG, "Creating activity; WebView debugging=" + debuggingEnabled);
		super.onCreate(savedInstanceState);
		logAudioPermissions();
	}

	@Override
	public void onStart() {
		super.onStart();
		Log.d(TAG, "Activity started");
	}

	@Override
	public void onResume() {
		super.onResume();
		Log.d(TAG, "Activity resumed");
		logAudioPermissions();
	}

	@Override
	public void onPause() {
		Log.d(TAG, "Activity paused");
		super.onPause();
	}

	@Override
	public void onStop() {
		Log.d(TAG, "Activity stopped");
		super.onStop();
	}

	@Override
	public void onDestroy() {
		Log.d(TAG, "Activity destroyed");
		super.onDestroy();
	}

	private void logAudioPermissions() {
		boolean recordAudioGranted = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
		boolean modifyAudioGranted = checkSelfPermission(Manifest.permission.MODIFY_AUDIO_SETTINGS) == PackageManager.PERMISSION_GRANTED;
		Log.i(TAG, "Audio permissions: RECORD_AUDIO=" + recordAudioGranted + ", MODIFY_AUDIO_SETTINGS=" + modifyAudioGranted);
	}
}
