package com.premoved.nativeplugin;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.StatFs;
import android.provider.DocumentsContract;
import android.text.TextUtils;
import android.util.Base64;
import android.view.Window;
import android.view.WindowManager;

import androidx.activity.result.ActivityResult;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.FileReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.LinkedHashMap;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * What the desktop app's Node shell does with the system, for the Android app: the Stockfish
 * process, the storage folder (Storage Access Framework), files in it, saving a file, and a few
 * window settings. The page reaches it through src/mobile/native.ts.
 */
@CapacitorPlugin(name = "PremovedNative")
public class PremovedNativePlugin extends Plugin {

    private static final String PREFS = "premovedprep";
    private static final String TREE = "storageTree";
    // Whether Documents/PremovedPrep was already there at this installation's first start (see inherited()).
    private static final String INHERITED = "defaultInherited";
    private static final String EXTERNAL_STORAGE = "com.android.externalstorage.documents";
    private static final String DOCUMENTS = "primary:Documents";
    private static final String ROOT_NAME = "PremovedPrep";
    private static final String TEMP_MIME = "application/octet-stream";

    // As on the desktop: only a web address or mailto is handed to the system.
    private static final Pattern HANDS_OVER = Pattern.compile("^(https?://|mailto:).*", Pattern.CASE_INSENSITIVE);

    private final Map<String, EngineSession> sessions = new ConcurrentHashMap<>();

    // A file being written piece by piece (an export): token → where it goes, and the stream into it.
    private static final class Export {
        final Uri target;
        final OutputStream output;

        Export(Uri target, OutputStream output) {
            this.target = target;
            this.output = output;
        }
    }

    private final Map<String, Export> exports = new ConcurrentHashMap<>();

    // ---------------------------------------------------------------- device

    @PluginMethod
    public void info(PluginCall call) {
        JSObject result = new JSObject();
        result.put("cpus", Runtime.getRuntime().availableProcessors());
        result.put("abi", Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "");
        result.put("sdk", Build.VERSION.SDK_INT);
        Map<String, String> engines = bundledEngines();
        result.put("engine", !engines.isEmpty());
        JSArray ids = new JSArray();
        for (String id : engines.keySet()) {
            ids.put(id);
        }
        result.put("engines", ids);
        call.resolve(result);
    }

    /** Free space where the app keeps its own data (the local databases live there). */
    @PluginMethod
    public void freeSpace(PluginCall call) {
        StatFs stat = new StatFs(getContext().getFilesDir().getAbsolutePath());
        JSObject result = new JSObject();
        result.put("bytes", stat.getAvailableBytes());
        result.put("total", stat.getTotalBytes());
        call.resolve(result);
    }

    /** The screen stays on while an indexing runs; Android would otherwise suspend the app. */
    @PluginMethod
    public void keepAwake(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        Activity activity = getActivity();
        activity.runOnUiThread(() -> {
            Window window = activity.getWindow();
            if (on) {
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } else {
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url", "");
        if (url == null || !HANDS_OVER.matcher(url).matches()) {
            call.reject("Only web addresses and mailto links are opened", "BAD_REQUEST");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("No app can open this link", "FAILED");
        }
    }

    /** Light or dark icons on the status and navigation bars, to match the theme behind them. */
    @PluginMethod
    public void systemBars(PluginCall call) {
        boolean dark = Boolean.TRUE.equals(call.getBoolean("darkBackground", false));
        Activity activity = getActivity();
        activity.runOnUiThread(() -> {
            Window window = activity.getWindow();
            WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
            controller.setAppearanceLightStatusBars(!dark);
            controller.setAppearanceLightNavigationBars(!dark);
            call.resolve();
        });
    }

    // ---------------------------------------------------------------- engine

    /**
     * The engines shipped in the APK, by id, in the order the page lists them. Each is a binary shipped
     * as a "library", the only kind of file Android still lets an app run (from nativeLibraryDir;
     * tools/fetch-engine.mjs puts them there, tools/patch-android.mjs makes Android extract them at
     * install). Lc0 carries its network inside the binary.
     */
    private Map<String, String> bundledEngines() {
        Map<String, String> found = new LinkedHashMap<>();
        String stockfish = stockfishPath();
        if (stockfish != null) {
            found.put("stockfish", stockfish);
        }
        File lc0 = new File(getContext().getApplicationInfo().nativeLibraryDir, "liblc0.so");
        if (lc0.exists()) {
            found.put("lc0", lc0.getAbsolutePath());
        }
        return found;
    }

    /** Stockfish: the Dot Product build only on a CPU that has it. */
    private String stockfishPath() {
        File directory = new File(getContext().getApplicationInfo().nativeLibraryDir);
        File dotProduct = new File(directory, "libstockfish_dotprod.so");
        File plain = new File(directory, "libstockfish.so");
        if (dotProduct.exists() && hasDotProduct()) {
            return dotProduct.getAbsolutePath();
        }
        return plain.exists() ? plain.getAbsolutePath() : null;
    }

    private static boolean hasDotProduct() {
        try (BufferedReader reader = new BufferedReader(new FileReader("/proc/cpuinfo"))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.startsWith("Features") && (" " + line + " ").contains(" asimddp ")) {
                    return true;
                }
            }
        } catch (IOException ignored) {
            // Unreadable: the plain build is the safe one.
        }
        return false;
    }

    @PluginMethod
    public void engineOpen(PluginCall call) {
        String which = call.getString("engine", "stockfish");
        String path = bundledEngines().get(which);
        if (path == null) {
            call.reject("The engine " + which + " is missing from this build", "NOT_FOUND");
            return;
        }
        try {
            // Started in the app's own files folder: anything an engine writes beside itself stays there.
            Process process = new ProcessBuilder(path).directory(getContext().getFilesDir()).start();
            String sessionId = UUID.randomUUID().toString();
            EngineSession session = new EngineSession(sessionId, process);
            sessions.put(sessionId, session);
            session.start();
            JSObject result = new JSObject();
            result.put("sessionId", sessionId);
            call.resolve(result);
        } catch (IOException error) {
            call.reject("The engine could not be started: " + error.getMessage(), "FAILED");
        }
    }

    @PluginMethod
    public void engineSend(PluginCall call) {
        EngineSession session = sessions.get(call.getString("sessionId", ""));
        String command = call.getString("command", "");
        if (session == null || command == null || command.indexOf('\n') >= 0 || command.indexOf('\r') >= 0) {
            call.resolve();
            return;
        }
        try {
            session.send(command);
        } catch (IOException ignored) {
            // The process is gone; engineClosed follows from its reader.
        }
        call.resolve();
    }

    @PluginMethod
    public void engineClose(PluginCall call) {
        EngineSession session = sessions.remove(call.getString("sessionId", ""));
        if (session != null) {
            session.close();
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        for (EngineSession session : sessions.values()) {
            session.process.destroy();
        }
        sessions.clear();
        super.handleOnDestroy();
    }

    private final class EngineSession {
        final String id;
        final Process process;
        final BufferedWriter input;

        EngineSession(String id, Process process) {
            this.id = id;
            this.process = process;
            this.input = new BufferedWriter(new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8));
        }

        void start() {
            Thread output = new Thread(this::readLines, "stockfish-out");
            output.setDaemon(true);
            output.start();
            // Read and dropped, as on the desktop (stdio 'ignore'): a full pipe would stall the engine.
            Thread errors = new Thread(this::drainErrors, "stockfish-err");
            errors.setDaemon(true);
            errors.start();
        }

        private void readLines() {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (line.isEmpty()) {
                        continue;
                    }
                    JSObject data = new JSObject();
                    data.put("sessionId", id);
                    data.put("line", line);
                    notifyListeners("engineLine", data);
                }
            } catch (IOException ignored) {
                // Closed under the reader: the session ends below.
            } finally {
                sessions.remove(id);
                JSObject data = new JSObject();
                data.put("sessionId", id);
                notifyListeners("engineClosed", data);
            }
        }

        private void drainErrors() {
            try (InputStream errors = process.getErrorStream()) {
                byte[] buffer = new byte[4096];
                while (errors.read(buffer) != -1) {
                    // Dropped.
                }
            } catch (IOException ignored) {
                // Process gone.
            }
        }

        synchronized void send(String command) throws IOException {
            input.write(command);
            input.write('\n');
            input.flush();
        }

        // quit lets the engine free its hash table; the process is ended a moment later regardless.
        void close() {
            try {
                send("quit");
            } catch (IOException ignored) {
                // Already gone.
            }
            new Handler(Looper.getMainLooper()).postDelayed(process::destroy, 1000);
        }
    }

    // ---------------------------------------------------------------- storage folder

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Activity.MODE_PRIVATE);
    }

    private Uri treeUri() {
        String saved = prefs().getString(TREE, null);
        return saved == null ? null : Uri.parse(saved);
    }

    private boolean granted(Uri tree) {
        for (UriPermission permission : getContext().getContentResolver().getPersistedUriPermissions()) {
            if (permission.getUri().equals(tree) && permission.isReadPermission() && permission.isWritePermission()) {
                return true;
            }
        }
        return false;
    }

    private JSObject folderStateOf(Uri tree) {
        JSObject state = new JSObject();
        if ((tree == null || !granted(tree)) && defaultFolder() != null) {
            state.put("chosen", true);
            state.put("granted", true);
            state.put("display", "Documents");
            state.put("isDefault", true);
            state.put("inherited", inherited());
            return state;
        }
        state.put("isDefault", false);
        state.put("chosen", tree != null);
        state.put("granted", tree != null && granted(tree));
        state.put("display", tree == null ? null : displayOf(tree));
        return state;
    }

    /** "primary:Documents" → "Documents"; "1234-5678:Chess" → "1234-5678/Chess"; "primary:" → "Internal storage". */
    private static String displayOf(Uri tree) {
        String id;
        try {
            id = DocumentsContract.getTreeDocumentId(tree);
        } catch (IllegalArgumentException error) {
            return tree.toString();
        }
        int colon = id.indexOf(':');
        String volume = colon < 0 ? id : id.substring(0, colon);
        String path = colon < 0 ? "" : id.substring(colon + 1);
        if ("primary".equals(volume)) {
            return path.isEmpty() ? "Internal storage" : path;
        }
        return path.isEmpty() ? volume : volume + "/" + path;
    }

    /**
     * Documents/PremovedPrep left by an earlier installation of the app: uninstalling leaves the folder
     * (Android keeps shared storage), but this installation cannot see the files in it until the user picks
     * the folder once. Looked at the first start only, before this installation writes anything there.
     */
    private boolean inherited() {
        SharedPreferences prefs = prefs();
        if (!prefs.contains(INHERITED)) {
            File documents = defaultFolder();
            // An update keeps the app's own files visible: only a new installation can find the folder foreign.
            boolean there = freshInstall() && documents != null && new File(documents, ROOT_NAME).isDirectory();
            prefs.edit().putBoolean(INHERITED, there).apply();
            return there;
        }
        return prefs.getBoolean(INHERITED, false);
    }

    /** Installed, not updated: an update keeps the install time of the first installation. */
    private boolean freshInstall() {
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            return info.firstInstallTime == info.lastUpdateTime;
        } catch (PackageManager.NameNotFoundException error) {
            return false;
        }
    }

    /** A question in the system's own dialog, for the moments before the page can ask (ok: the first button). */
    @PluginMethod
    public void confirm(PluginCall call) {
        String title = call.getString("title", "");
        String message = call.getString("message", "");
        String ok = call.getString("ok", "OK");
        String cancel = call.getString("cancel", "Cancel");
        getActivity().runOnUiThread(() -> {
            boolean[] answered = { false };
            new AlertDialog.Builder(getActivity())
                .setTitle(title)
                .setMessage(message)
                .setPositiveButton(ok, (dialog, which) -> answer(call, answered, true))
                .setNegativeButton(cancel, (dialog, which) -> answer(call, answered, false))
                .setOnCancelListener((dialog) -> answer(call, answered, false))
                .show();
        });
    }

    private static void answer(PluginCall call, boolean[] answered, boolean ok) {
        if (answered[0]) {
            return;
        }
        answered[0] = true;
        JSObject result = new JSObject();
        result.put("ok", ok);
        call.resolve(result);
    }

    @PluginMethod
    public void folderState(PluginCall call) {
        call.resolve(folderStateOf(treeUri()));
    }

    /** The system's folder picker, opened on Documents; the choice is kept across restarts. */
    @PluginMethod
    public void folderPick(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION |
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION |
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION |
            Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
        );
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, DocumentsContract.buildDocumentUri(EXTERNAL_STORAGE, DOCUMENTS));
        }
        startActivityForResult(call, intent, "folderPicked");
    }

    @ActivityCallback
    private void folderPicked(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        Uri previous = treeUri();
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            JSObject state = folderStateOf(previous);
            state.put("picked", false);
            call.resolve(state);
            return;
        }
        Uri tree = result.getData().getData();
        int flags = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
        ContentResolver resolver = getContext().getContentResolver();
        try {
            resolver.takePersistableUriPermission(tree, flags);
        } catch (SecurityException error) {
            call.reject("Android did not allow the app to keep using that folder", "FAILED");
            return;
        }
        if (previous != null && !previous.equals(tree)) {
            try {
                resolver.releasePersistableUriPermission(previous, flags);
            } catch (SecurityException ignored) {
                // Already gone.
            }
        }
        prefs().edit().putString(TREE, tree.toString()).apply();
        folderIds.clear();
        JSObject state = folderStateOf(tree);
        state.put("picked", true);
        call.resolve(state);
    }

    // ---------------------------------------------------------------- files in the folder
    //
    // Two kinds of folder, the same answers. The default one (Documents, when no folder was picked) is
    // reached with plain files. A picked one is reached through the documents API, asking for the name,
    // kind, size and date of all the children of a folder in one query. (DocumentFile asked for each of
    // them separately: one query per file and per field, and a path walked from the top each time,
    // which made reading the folder take seconds.)

    /** The folder the user picked, while Android still lets the app use it. */
    private Uri pickedTree() {
        Uri tree = treeUri();
        return tree != null && granted(tree) ? tree : null;
    }

    /**
     * Documents on the device's own storage, where PremovedPrep/ is made at the first start without asking:
     * from Android 11 an app may keep its own files in Documents with no permission. It sees the files it
     * wrote there, not ones another app or a computer put there; for those the user picks a folder.
     * Before Android 11 there is no default, and the folder is picked.
     */
    private static File defaultFolder() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return null;
        }
        File documents = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS);
        if (!documents.isDirectory() && !documents.mkdirs()) {
            return null;
        }
        return documents;
    }

    /** Names between "/", never "." or "..": a path cannot leave the folder. */
    private static List<String> segments(String path) {
        List<String> names = new ArrayList<>();
        if (path == null) {
            return names;
        }
        for (String name : path.split("/")) {
            if (name.isEmpty()) {
                continue;
            }
            if (name.equals(".") || name.equals("..")) {
                throw new IllegalArgumentException("Not a path inside the folder: " + path);
            }
            names.add(name);
        }
        return names;
    }

    private static String clean(String path) {
        return TextUtils.join("/", segments(path));
    }

    private static String parentOf(String path) {
        int at = path.lastIndexOf('/');
        return at < 0 ? "" : path.substring(0, at);
    }

    private static String nameOf(String path) {
        return path.substring(path.lastIndexOf('/') + 1);
    }

    private static File fileAt(File base, String path) {
        File at = base;
        for (String name : segments(path)) {
            at = new File(at, name);
        }
        return at;
    }

    private static JSObject described(String name, boolean dir, long size, long mtime) {
        JSObject entry = new JSObject();
        entry.put("name", name);
        entry.put("dir", dir);
        entry.put("size", size);
        entry.put("mtime", mtime);
        return entry;
    }

    private static String readAll(InputStream input) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        byte[] buffer = new byte[1 << 16];
        int read;
        while ((read = input.read(buffer)) != -1) {
            bytes.write(buffer, 0, read);
        }
        return new String(bytes.toByteArray(), StandardCharsets.UTF_8);
    }

    /** One child of a folder in the picked tree, as the documents API describes it. */
    private static final class Child {
        final String id;
        final String name;
        final boolean dir;
        final long size;
        final long mtime;

        Child(String id, String name, boolean dir, long size, long mtime) {
            this.id = id;
            this.name = name;
            this.dir = dir;
            this.size = size;
            this.mtime = mtime;
        }
    }

    private static final String[] COLUMNS = {
        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        DocumentsContract.Document.COLUMN_MIME_TYPE,
        DocumentsContract.Document.COLUMN_SIZE,
        DocumentsContract.Document.COLUMN_LAST_MODIFIED,
    };

    // Folder path → its document id in the picked tree, so a path is not walked from the top each time.
    // Cleared when another folder is picked, and when an id turns out to be gone (the folder was changed
    // outside the app): the call is then tried once more from the top.
    private final Map<String, String> folderIds = new ConcurrentHashMap<>();
    private volatile String folderIdsTree = null;

    private List<Child> children(Uri tree, String parentId) throws FileNotFoundException {
        Uri uri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId);
        List<Child> found = new ArrayList<>();
        Cursor cursor;
        try {
            cursor = getContext().getContentResolver().query(uri, COLUMNS, null, null, null);
        } catch (IllegalArgumentException | IllegalStateException | UnsupportedOperationException error) {
            throw new FileNotFoundException(parentId);
        }
        if (cursor == null) {
            throw new FileNotFoundException(parentId);
        }
        try {
            while (cursor.moveToNext()) {
                String id = cursor.getString(0);
                String name = cursor.getString(1);
                if (id == null || name == null) {
                    continue;
                }
                boolean dir = DocumentsContract.Document.MIME_TYPE_DIR.equals(cursor.getString(2));
                long size = cursor.isNull(3) ? 0 : cursor.getLong(3);
                long mtime = cursor.isNull(4) ? 0 : cursor.getLong(4);
                found.add(new Child(id, name, dir, size, mtime));
            }
        } finally {
            cursor.close();
        }
        return found;
    }

    private Child child(Uri tree, String parentId, String name) throws FileNotFoundException {
        for (Child one : children(tree, parentId)) {
            if (one.name.equals(name)) {
                return one;
            }
        }
        return null;
    }

    /** The document id of a folder in the picked tree; null when it is not there (and was not made). */
    private String folderId(Uri tree, String path, boolean create) throws FileNotFoundException {
        String treeKey = tree.toString();
        if (!treeKey.equals(folderIdsTree)) {
            folderIds.clear();
            folderIdsTree = treeKey;
        }
        String at = clean(path);
        String known = at.isEmpty() ? DocumentsContract.getTreeDocumentId(tree) : folderIds.get(at);
        if (known != null) {
            return known;
        }
        if (pathIds(tree)) {
            Child found = document(tree, idOf(tree, at));
            if (found != null) {
                if (!found.dir) {
                    return null;
                }
                folderIds.put(at, found.id);
                return found.id;
            }
            if (!create) {
                return null;
            }
        }
        String id = DocumentsContract.getTreeDocumentId(tree);
        StringBuilder walked = new StringBuilder();
        for (String name : segments(path)) {
            if (walked.length() > 0) {
                walked.append('/');
            }
            walked.append(name);
            String key = walked.toString();
            String kept = folderIds.get(key);
            if (kept != null) {
                id = kept;
                continue;
            }
            Child found = child(tree, id, name);
            if (found != null && !found.dir) {
                return null;
            }
            if (found == null) {
                if (!create) {
                    return null;
                }
                Uri made = DocumentsContract.createDocument(
                    getContext().getContentResolver(),
                    DocumentsContract.buildDocumentUriUsingTree(tree, id),
                    DocumentsContract.Document.MIME_TYPE_DIR,
                    name
                );
                if (made == null) {
                    return null;
                }
                id = DocumentsContract.getDocumentId(made);
            } else {
                id = found.id;
            }
            folderIds.put(key, id);
        }
        return id;
    }

    /**
     * On the device's own storage (and a memory card) a document's id is its path, as in
     * "primary:Documents/PremovedPrep/Library/x.pgn": a file is reached in one query instead of a walk.
     */
    private static boolean pathIds(Uri tree) {
        return EXTERNAL_STORAGE.equals(tree.getAuthority());
    }

    private static String idOf(Uri tree, String path) {
        String root = DocumentsContract.getTreeDocumentId(tree);
        String at = clean(path);
        if (at.isEmpty()) {
            return root;
        }
        return root.endsWith(":") || root.endsWith("/") ? root + at : root + "/" + at;
    }

    /** One document of the picked tree, by id; null when it is not there. */
    private Child document(Uri tree, String id) {
        Uri uri = DocumentsContract.buildDocumentUriUsingTree(tree, id);
        Cursor cursor;
        try {
            cursor = getContext().getContentResolver().query(uri, COLUMNS, null, null, null);
        } catch (IllegalArgumentException | IllegalStateException | UnsupportedOperationException error) {
            return null;
        }
        if (cursor == null) {
            return null;
        }
        try {
            if (!cursor.moveToFirst()) {
                return null;
            }
            String name = cursor.getString(1);
            boolean dir = DocumentsContract.Document.MIME_TYPE_DIR.equals(cursor.getString(2));
            long size = cursor.isNull(3) ? 0 : cursor.getLong(3);
            long mtime = cursor.isNull(4) ? 0 : cursor.getLong(4);
            return new Child(id, name == null ? "" : name, dir, size, mtime);
        } finally {
            cursor.close();
        }
    }

    /** A file named name in the folder at parentPath (whose id is parentId); null when it is not there. */
    private Child childAt(Uri tree, String parentId, String parentPath, String name) throws FileNotFoundException {
        if (pathIds(tree)) {
            return document(tree, idOf(tree, parentPath.isEmpty() ? name : parentPath + "/" + name));
        }
        return child(tree, parentId, name);
    }

    /** A file or folder of the picked tree; null when it is not there. */
    private Child entry(Uri tree, String path) throws FileNotFoundException {
        if (pathIds(tree)) {
            return document(tree, idOf(tree, path));
        }
        String at = clean(path);
        if (at.isEmpty()) {
            return new Child(DocumentsContract.getTreeDocumentId(tree), "", true, 0, 0);
        }
        String parent = folderId(tree, parentOf(at), false);
        return parent == null ? null : child(tree, parent, nameOf(at));
    }

    /** After a rename or a removal: the folder ids kept for that path, and below it, are dropped. */
    private void forget(String path) {
        String at = clean(path);
        for (String key : new ArrayList<>(folderIds.keySet())) {
            if (key.equals(at) || key.startsWith(at + "/")) {
                folderIds.remove(key);
            }
        }
    }

    private interface FolderTask {
        void run(File base, Uri tree) throws IOException;
    }

    /** Runs a file call on whichever folder is in use, answering every failure as the page expects. */
    private void inFolder(PluginCall call, FolderTask task) {
        Uri tree = pickedTree();
        File base = tree == null ? defaultFolder() : null;
        if (base == null && tree == null) {
            call.reject("No storage folder has been chosen on this device", "BAD_REQUEST");
            return;
        }
        try {
            try {
                task.run(base, tree);
            } catch (FileNotFoundException stale) {
                if (tree == null) {
                    throw stale;
                }
                folderIds.clear();
                task.run(base, tree);
            }
        } catch (IllegalArgumentException error) {
            call.reject(error.getMessage(), "BAD_REQUEST");
        } catch (SecurityException error) {
            call.reject("Android no longer lets the app use that folder", "FAILED");
        } catch (IOException error) {
            call.reject("The folder could not be used: " + error.getMessage(), "FAILED");
        }
    }

    @PluginMethod
    public void fsList(PluginCall call) {
        inFolder(call, (base, tree) -> {
            String path = call.getString("path", "");
            JSArray entries = new JSArray();
            boolean exists;
            if (base != null) {
                File directory = fileAt(base, path);
                File[] listed = directory.isDirectory() ? directory.listFiles() : null;
                exists = listed != null;
                if (listed != null) {
                    for (File file : listed) {
                        entries.put(described(file.getName(), file.isDirectory(), file.length(), file.lastModified()));
                    }
                }
            } else {
                String id = folderId(tree, path, false);
                exists = id != null;
                if (id != null) {
                    for (Child one : children(tree, id)) {
                        entries.put(described(one.name, one.dir, one.size, one.mtime));
                    }
                }
            }
            JSObject result = new JSObject();
            result.put("exists", exists);
            result.put("entries", entries);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void fsStat(PluginCall call) {
        inFolder(call, (base, tree) -> {
            String path = call.getString("path", "");
            JSObject result = new JSObject();
            if (base != null) {
                File file = fileAt(base, path);
                boolean exists = file.exists();
                result.put("exists", exists);
                result.put("dir", exists && file.isDirectory());
                result.put("size", exists ? file.length() : 0);
                result.put("mtime", exists ? file.lastModified() : 0);
            } else {
                Child one = entry(tree, path);
                result.put("exists", one != null);
                result.put("dir", one != null && one.dir);
                result.put("size", one == null ? 0 : one.size);
                result.put("mtime", one == null ? 0 : one.mtime);
            }
            call.resolve(result);
        });
    }

    @PluginMethod
    public void fsRead(PluginCall call) {
        inFolder(call, (base, tree) -> {
            String path = call.getString("path", "");
            String text;
            if (base != null) {
                File file = fileAt(base, path);
                if (!file.isFile()) {
                    call.reject("That file is no longer in the folder", "NOT_FOUND");
                    return;
                }
                try (InputStream input = new FileInputStream(file)) {
                    text = readAll(input);
                }
            } else {
                Child one = entry(tree, path);
                if (one == null || one.dir) {
                    call.reject("That file is no longer in the folder", "NOT_FOUND");
                    return;
                }
                Uri uri = DocumentsContract.buildDocumentUriUsingTree(tree, one.id);
                try (InputStream input = getContext().getContentResolver().openInputStream(uri)) {
                    if (input == null) {
                        call.reject("The file could not be opened", "FAILED");
                        return;
                    }
                    text = readAll(input);
                }
            }
            JSObject result = new JSObject();
            result.put("text", text);
            call.resolve(result);
        });
    }

    /**
     * Written to a hidden temporary file beside it, then put in its place, as the desktop writes: an
     * interrupted write leaves the old version (or, at worst, the new one under the temporary name).
     */
    @PluginMethod
    public void fsWrite(PluginCall call) {
        inFolder(call, (base, tree) -> {
            String path = call.getString("path", "");
            String text = call.getString("text", "");
            if (base != null) {
                writeFile(call, base, path, text);
            } else {
                writeDocument(call, tree, path, text);
            }
        });
    }

    /** In the default folder a rename replaces the old file in one step. */
    private void writeFile(PluginCall call, File base, String path, String text) throws IOException {
        File target = fileAt(base, path);
        File directory = target.getParentFile();
        if (target.equals(base) || directory == null || (!directory.isDirectory() && !directory.mkdirs())) {
            call.reject("The folder could not be created", "FAILED");
            return;
        }
        File temporary = new File(directory, "." + target.getName() + "." + UUID.randomUUID() + ".tmp");
        try (FileOutputStream output = new FileOutputStream(temporary)) {
            output.write(text.getBytes(StandardCharsets.UTF_8));
            output.getFD().sync();
        } catch (IOException error) {
            temporary.delete();
            throw error;
        }
        if (!temporary.renameTo(target)) {
            temporary.delete();
            call.reject("The file was written but could not be renamed", "FAILED");
            return;
        }
        call.resolve();
    }

    /** In a picked folder the documents API cannot rename over a file: the old one is removed first. */
    private void writeDocument(PluginCall call, Uri tree, String path, String text) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        String at = clean(path);
        String name = at.isEmpty() ? "" : nameOf(at);
        String parent = name.isEmpty() ? null : folderId(tree, parentOf(at), true);
        if (parent == null) {
            call.reject("The folder could not be created", "FAILED");
            return;
        }
        Uri parentUri = DocumentsContract.buildDocumentUriUsingTree(tree, parent);
        Uri temporary = DocumentsContract.createDocument(resolver, parentUri, TEMP_MIME, "." + name + "." + UUID.randomUUID() + ".tmp");
        if (temporary == null) {
            call.reject("The file could not be created", "FAILED");
            return;
        }
        try (OutputStream output = resolver.openOutputStream(temporary, "wt")) {
            if (output == null) {
                DocumentsContract.deleteDocument(resolver, temporary);
                call.reject("The file could not be written", "FAILED");
                return;
            }
            output.write(text.getBytes(StandardCharsets.UTF_8));
        } catch (IOException error) {
            DocumentsContract.deleteDocument(resolver, temporary);
            throw error;
        }
        Child existing = childAt(tree, parent, parentOf(at), name);
        if (existing != null && !DocumentsContract.deleteDocument(resolver, DocumentsContract.buildDocumentUriUsingTree(tree, existing.id))) {
            DocumentsContract.deleteDocument(resolver, temporary);
            call.reject("The old file could not be replaced", "FAILED");
            return;
        }
        if (DocumentsContract.renameDocument(resolver, temporary, name) == null && childAt(tree, parent, parentOf(at), name) == null) {
            call.reject("The file was written but could not be renamed", "FAILED");
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void fsRename(PluginCall call) {
        inFolder(call, (base, tree) -> {
            String path = call.getString("path", "");
            String name = call.getString("name", "");
            if (name == null || name.isEmpty() || name.contains("/") || name.equals(".") || name.equals("..")) {
                call.reject("The file could not be renamed", "FAILED");
                return;
            }
            if (base != null) {
                File file = fileAt(base, path);
                if (!file.exists()) {
                    call.reject("That file is no longer in the folder", "NOT_FOUND");
                    return;
                }
                File target = new File(file.getParentFile(), name);
                if (target.exists() || !file.renameTo(target)) {
                    call.reject("The file could not be renamed", "FAILED");
                    return;
                }
            } else {
                Child one = entry(tree, path);
                if (one == null) {
                    call.reject("That file is no longer in the folder", "NOT_FOUND");
                    return;
                }
                Uri uri = DocumentsContract.buildDocumentUriUsingTree(tree, one.id);
                if (DocumentsContract.renameDocument(getContext().getContentResolver(), uri, name) == null) {
                    call.reject("The file could not be renamed", "FAILED");
                    return;
                }
                forget(path);
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void fsRemove(PluginCall call) {
        inFolder(call, (base, tree) -> {
            String path = call.getString("path", "");
            if (clean(path).isEmpty()) {
                call.reject("The folder itself cannot be removed", "BAD_REQUEST");
                return;
            }
            if (base != null) {
                File file = fileAt(base, path);
                if (file.exists() && !file.delete()) {
                    call.reject("The file could not be removed", "FAILED");
                    return;
                }
            } else {
                Child one = entry(tree, path);
                if (one != null) {
                    Uri uri = DocumentsContract.buildDocumentUriUsingTree(tree, one.id);
                    if (!DocumentsContract.deleteDocument(getContext().getContentResolver(), uri)) {
                        call.reject("The file could not be removed", "FAILED");
                        return;
                    }
                    forget(path);
                }
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void fsMkdirs(PluginCall call) {
        inFolder(call, (base, tree) -> {
            String path = call.getString("path", "");
            boolean made;
            if (base != null) {
                File directory = fileAt(base, path);
                made = directory.isDirectory() || directory.mkdirs();
            } else {
                made = folderId(tree, path, true) != null;
            }
            if (!made) {
                call.reject("The folder could not be created", "FAILED");
                return;
            }
            call.resolve();
        });
    }

    // ---------------------------------------------------------------- saving a file

    /** The system's save dialog, on PremovedPrep/ when the folder is chosen, else on Documents. */
    @PluginMethod
    public void saveFile(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("mime", TEMP_MIME));
        intent.putExtra(Intent.EXTRA_TITLE, call.getString("name", "PremovedPrep"));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, saveLocation());
        }
        startActivityForResult(call, intent, "fileSaved");
    }

    private Uri saveLocation() {
        Uri tree = treeUri();
        if (tree != null && granted(tree)) {
            try {
                String id = DocumentsContract.getTreeDocumentId(tree);
                return DocumentsContract.buildDocumentUriUsingTree(tree, id + "/" + ROOT_NAME);
            } catch (IllegalArgumentException ignored) {
                // Not a tree the system can build a child of: Documents below.
            }
        }
        if (defaultFolder() != null) {
            return DocumentsContract.buildDocumentUri(EXTERNAL_STORAGE, DOCUMENTS + "/" + ROOT_NAME);
        }
        return DocumentsContract.buildDocumentUri(EXTERNAL_STORAGE, DOCUMENTS);
    }

    @ActivityCallback
    private void fileSaved(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        JSObject answer = new JSObject();
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            answer.put("saved", false);
            call.resolve(answer);
            return;
        }
        Uri target = result.getData().getData();
        byte[] bytes = Base64.decode(call.getString("base64", ""), Base64.DEFAULT);
        try (OutputStream output = getContext().getContentResolver().openOutputStream(target, "wt")) {
            if (output == null) {
                call.reject("The file could not be written", "FAILED");
                return;
            }
            output.write(bytes);
        } catch (IOException error) {
            call.reject("The file could not be written: " + error.getMessage(), "FAILED");
            return;
        }
        answer.put("saved", true);
        call.resolve(answer);
    }

    /**
     * The system's save dialog for a file too large to pass in one call (a database export): the page then
     * sends it in pieces (exportWrite) and ends with exportEnd, which removes the file if it was not finished.
     */
    @PluginMethod
    public void exportBegin(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("mime", TEMP_MIME));
        intent.putExtra(Intent.EXTRA_TITLE, call.getString("name", "PremovedPrep"));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, saveLocation());
        }
        startActivityForResult(call, intent, "exportPicked");
    }

    @ActivityCallback
    private void exportPicked(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        JSObject answer = new JSObject();
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            answer.put("saved", false);
            call.resolve(answer);
            return;
        }
        Uri target = result.getData().getData();
        try {
            OutputStream output = getContext().getContentResolver().openOutputStream(target, "wt");
            if (output == null) {
                call.reject("The file could not be written", "FAILED");
                return;
            }
            String token = UUID.randomUUID().toString();
            exports.put(token, new Export(target, output));
            answer.put("saved", true);
            answer.put("token", token);
            answer.put("name", nameOf(target));
            call.resolve(answer);
        } catch (IOException error) {
            call.reject("The file could not be written: " + error.getMessage(), "FAILED");
        }
    }

    /** The name the user gave the file, as the system shows it. */
    private String nameOf(Uri target) {
        try (Cursor cursor = getContext().getContentResolver().query(
            target, new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME }, null, null, null
        )) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) {
                return cursor.getString(0);
            }
        } catch (RuntimeException ignored) {
            // The name is only shown.
        }
        return "";
    }

    @PluginMethod
    public void exportWrite(PluginCall call) {
        Export export = exports.get(call.getString("token", ""));
        if (export == null) {
            call.reject("That export is no longer open", "NOT_FOUND");
            return;
        }
        try {
            export.output.write(Base64.decode(call.getString("base64", ""), Base64.DEFAULT));
            call.resolve();
        } catch (IOException error) {
            call.reject("The file could not be written: " + error.getMessage(), "FAILED");
        }
    }

    @PluginMethod
    public void exportEnd(PluginCall call) {
        Export export = exports.remove(call.getString("token", ""));
        if (export == null) {
            call.resolve();
            return;
        }
        boolean ok = Boolean.TRUE.equals(call.getBoolean("ok", false));
        try {
            export.output.flush();
            export.output.close();
        } catch (IOException error) {
            ok = false;
        }
        if (!ok) {
            try {
                DocumentsContract.deleteDocument(getContext().getContentResolver(), export.target);
            } catch (FileNotFoundException | RuntimeException ignored) {
                // Nothing left to remove.
            }
        }
        call.resolve();
    }

    // ---------------------------------------------------------------- downloads

    /**
     * A file from the server into the app's cache (the offline player list): native code, as the page's
     * API requests, so no CORS; the page then reads it from its own origin (Capacitor.convertFileSrc).
     */
    @PluginMethod
    public void download(PluginCall call) {
        String address = call.getString("url", "");
        String name = call.getString("name", "download");
        if (address == null || !address.startsWith("https://") || name == null || name.contains("/") || name.isEmpty()) {
            call.reject("Not a file the app downloads", "BAD_REQUEST");
            return;
        }
        File target = new File(getContext().getCacheDir(), name);
        File partial = new File(getContext().getCacheDir(), name + ".part");
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(address).openConnection();
            connection.setConnectTimeout(20000);
            connection.setReadTimeout(60000);
            connection.setInstanceFollowRedirects(true);
            int status = connection.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) {
                call.reject("The download failed (HTTP " + status + ")", "FAILED");
                return;
            }
            long bytes = 0;
            try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(partial)) {
                byte[] buffer = new byte[1 << 16];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    output.write(buffer, 0, read);
                    bytes += read;
                }
            }
            if (target.exists() && !target.delete()) {
                partial.delete();
                call.reject("The old download could not be replaced", "FAILED");
                return;
            }
            if (!partial.renameTo(target)) {
                partial.delete();
                call.reject("The download could not be kept", "FAILED");
                return;
            }
            JSObject result = new JSObject();
            result.put("path", target.getAbsolutePath());
            result.put("bytes", bytes);
            call.resolve(result);
        } catch (IOException error) {
            partial.delete();
            call.reject("The download failed: " + error.getMessage(), "FAILED");
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    /** A file download() kept, once the page has read it. */
    @PluginMethod
    public void downloadRemove(PluginCall call) {
        String name = call.getString("name", "");
        if (name != null && !name.isEmpty() && !name.contains("/")) {
            new File(getContext().getCacheDir(), name).delete();
        }
        call.resolve();
    }
}
