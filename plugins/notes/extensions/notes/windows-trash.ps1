param([Parameter(Mandatory = $true)][string]$EncodedPath)
$ErrorActionPreference = 'Stop'

# FOFX_RECYCLEONDELETE forbids the permanent-delete fallback of older shell APIs.
# https://learn.microsoft.com/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifileoperation-setoperationflags
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class NotesRecycle {
    [ComImport, Guid("947AAB5F-0A5C-4C13-B4D6-4BF7836FC9F8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOperation {
        [PreserveSig] int Advise(IntPtr sink, out uint cookie);
        [PreserveSig] int Unadvise(uint cookie);
        [PreserveSig] int SetOperationFlags(uint flags);
        [PreserveSig] int SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string message);
        [PreserveSig] int SetProgressDialog(IntPtr dialog);
        [PreserveSig] int SetProperties(IntPtr properties);
        [PreserveSig] int SetOwnerWindow(IntPtr window);
        [PreserveSig] int ApplyPropertiesToItem(IntPtr item);
        [PreserveSig] int ApplyPropertiesToItems(IntPtr items);
        [PreserveSig] int RenameItem(IntPtr item, IntPtr name, IntPtr sink);
        [PreserveSig] int RenameItems(IntPtr items, IntPtr name);
        [PreserveSig] int MoveItem(IntPtr item, IntPtr destination, IntPtr name, IntPtr sink);
        [PreserveSig] int MoveItems(IntPtr items, IntPtr destination);
        [PreserveSig] int CopyItem(IntPtr item, IntPtr destination, IntPtr name, IntPtr sink);
        [PreserveSig] int CopyItems(IntPtr items, IntPtr destination);
        [PreserveSig] int DeleteItem(IntPtr item, IntPtr sink);
        [PreserveSig] int DeleteItems(IntPtr items);
        [PreserveSig] int NewItem(IntPtr destination, uint attributes, IntPtr name, IntPtr template, IntPtr sink);
        [PreserveSig] int PerformOperations();
        [PreserveSig] int GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int SHCreateItemFromParsingName(string path, IntPtr context, ref Guid iid, out IntPtr item);

    public static void Delete(string path) {
        var type = Type.GetTypeFromCLSID(new Guid("3AD05575-8857-4850-9277-11B85BDB8E09"));
        var operation = (IFileOperation)Activator.CreateInstance(type);
        IntPtr item = IntPtr.Zero;
        try {
            var iid = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
            Marshal.ThrowExceptionForHR(SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out item));
            const uint FOF_SILENT = 0x0004, FOF_NOCONFIRMATION = 0x0010, FOF_NOERRORUI = 0x0400;
            const uint FOF_NO_CONNECTED_ELEMENTS = 0x2000, FOFX_RECYCLEONDELETE = 0x00080000;
            const uint FOFX_EARLYFAILURE = 0x00100000, FOFX_ADDUNDORECORD = 0x20000000;
            Marshal.ThrowExceptionForHR(operation.SetOperationFlags(FOF_SILENT | FOF_NOCONFIRMATION |
                FOF_NOERRORUI | FOF_NO_CONNECTED_ELEMENTS | FOFX_RECYCLEONDELETE |
                FOFX_EARLYFAILURE | FOFX_ADDUNDORECORD));
            Marshal.ThrowExceptionForHR(operation.DeleteItem(item, IntPtr.Zero));
            Marshal.ThrowExceptionForHR(operation.PerformOperations());
            bool aborted;
            Marshal.ThrowExceptionForHR(operation.GetAnyOperationsAborted(out aborted));
            if (aborted) throw new InvalidOperationException("The recycle operation was cancelled.");
        } finally {
            if (item != IntPtr.Zero) Marshal.Release(item);
            Marshal.FinalReleaseComObject(operation);
        }
    }
}
'@

[NotesRecycle]::Delete([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedPath)))
