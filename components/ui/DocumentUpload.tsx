import React, { useState, useCallback } from 'react';
import { Upload, X, FileText, CheckCircle, AlertCircle, Loader2, Eye, Clock } from 'lucide-react';
import { Button } from './Button';
import type { CaregiverDocument } from '../../types';
import type { DocumentType } from '../../services/documentUpload';

interface DocumentUploadProps {
  type: DocumentType;
  label: string;
  description?: string;
  existingDocument?: CaregiverDocument;
  onUpload: (file: File, type: DocumentType) => Promise<void>;
  onDelete?: (type: DocumentType) => Promise<void>;
  onPreview?: (doc: CaregiverDocument) => void;
  acceptedTypes?: string;
  maxSizeMB?: number;
}

export const DocumentUpload: React.FC<DocumentUploadProps> = ({
  type,
  label,
  description,
  existingDocument,
  onUpload,
  onDelete,
  onPreview,
  acceptedTypes = 'image/*,.pdf',
  maxSizeMB = 5
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [showReplace, setShowReplace] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const validateFile = (file: File): string | null => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowedTypes.includes(file.type)) {
      return 'Invalid file type. Please upload an image (JPEG, PNG) or PDF.';
    }
    if (file.size > maxSizeMB * 1024 * 1024) {
      return `File too large. Maximum size is ${maxSizeMB}MB.`;
    }
    return null;
  };

  const handleFileSelect = useCallback(async (file: File) => {
    setError(null);
    
    const validationError = validateFile(file);
    if (validationError) {
      setError(validationError);
      return;
    }

    // Show preview for images
    if (file.type.startsWith('image/')) {
      setPreviewFile(file);
    }

    setIsUploading(true);
    setUploadProgress(0);

    try {
      await onUpload(file, type);
      setPreviewFile(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setIsUploading(false);
    }
  }, [type, onUpload, maxSizeMB]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const file = e.dataTransfer.files[0];
    if (file) {
      handleFileSelect(file);
    }
  }, [handleFileSelect]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
  }, [handleFileSelect]);

  const handleDelete = useCallback(async () => {
    if (!onDelete || !existingDocument) return;
    
    try {
      await onDelete(type);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }, [type, onDelete, existingDocument]);

  const getStatusIcon = () => {
    switch (existingDocument?.status) {
      case 'approved':
        return <CheckCircle className="w-5 h-5 text-green-500" />;
      case 'rejected':
        return <AlertCircle className="w-5 h-5 text-red-500" />;
      case 'pending':
      default:
        return <Clock className="w-5 h-5 text-accent-500" />;
    }
  };

  const getStatusColor = () => {
    switch (existingDocument?.status) {
      case 'approved':
        return 'bg-green-50 border-green-200 text-green-700';
      case 'rejected':
        return 'bg-red-50 border-red-200 text-red-700';
      case 'pending':
      default:
        return 'bg-accent-50 border-accent-200 text-accent-700';
    }
  };

  // Check if document is expired
  const isExpired = existingDocument?.expirationDate 
    ? new Date(existingDocument.expirationDate) < new Date()
    : false;

  // Check if update is allowed (rejected, pending, or expired approved)
  const canUpdate = !existingDocument || 
    existingDocument.status === 'rejected' || 
    existingDocument.status === 'pending' ||
    (existingDocument.status === 'approved' && isExpired);

  // Show uploaded document state
  if (existingDocument && !previewFile) {
    return (
      <div className={`p-4 rounded-xl border ${getStatusColor()}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {getStatusIcon()}
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm">{existingDocument.documentName || label}</p>
              <p className="text-xs opacity-75 truncate max-w-[200px]">
                {existingDocument.fileName || 'Document uploaded'}
              </p>
              <div className="flex items-center gap-2 mt-1">
                <p className="text-xs opacity-60">
                  Uploaded: {new Date(existingDocument.uploadedAt).toLocaleDateString()}
                </p>
                {existingDocument.expirationDate && (
                  <p className={`text-xs ${isExpired ? 'text-red-600 font-medium' : 'opacity-60'}`}>
                    • Expires: {new Date(existingDocument.expirationDate).toLocaleDateString()}
                    {isExpired && ' (EXPIRED)'}
                  </p>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-xs px-2 py-1 rounded-full font-medium uppercase ${
              existingDocument.status === 'approved' ? 'bg-green-100 text-green-700' :
              existingDocument.status === 'rejected' ? 'bg-red-100 text-red-700' :
              'bg-accent-100 text-accent-700'
            }`}>
              {existingDocument.status}
            </span>
            {onPreview && (
              <button
                onClick={() => onPreview(existingDocument)}
                className="p-3 hover:bg-white/50 rounded-lg transition-colors min-w-[48px] min-h-[48px] flex items-center justify-center"
                title="Preview"
                aria-label="Preview document"
              >
                <Eye className="w-5 h-5" />
              </button>
            )}
            {existingDocument.status === 'approved' && !isExpired && (
              <span className="text-xs text-green-600 bg-green-100 px-2 py-1 rounded-full">
                Approved
              </span>
            )}
          </div>
        </div>
        {existingDocument.notes && existingDocument.status === 'rejected' && (
          <div className="mt-2 text-xs text-red-600 bg-red-50 p-2 rounded">
            <strong>Reason:</strong> {existingDocument.notes}
          </div>
        )}
        {(existingDocument.status === 'rejected' || (existingDocument.status === 'approved' && isExpired)) && (
          <div className="mt-3">
            {!showReplace ? (
              <button
                onClick={() => setShowReplace(true)}
                className={`w-full text-sm font-medium border bg-white rounded-lg px-4 py-2 transition-colors flex items-center justify-center gap-2 ${
                  isExpired
                    ? 'text-orange-700 border-orange-300 hover:bg-orange-50'
                    : 'text-red-700 border-red-300 hover:bg-red-50'
                }`}
              >
                <Upload className="w-4 h-4" />
                {isExpired ? 'Upload renewed document' : 'Replace document'}
              </button>
            ) : (
              <div>
                <div
                  onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={e => { e.preventDefault(); setIsDragging(false); }}
                  onDrop={e => { e.preventDefault(); setIsDragging(false); const f = e.dataTransfer.files[0]; if (f) handleFileSelect(f); }}
                  className={`border-2 border-dashed rounded-xl p-4 text-center transition-colors cursor-pointer ${
                    isDragging
                      ? isExpired ? 'border-orange-400 bg-orange-50' : 'border-red-400 bg-red-50'
                      : isExpired ? 'border-orange-200 hover:border-orange-400 bg-orange-50/50' : 'border-red-200 hover:border-red-400 bg-red-50/50'
                  }`}
                >
                  <input type="file" accept={acceptedTypes} onChange={handleInputChange} className="hidden" id={`replace-${type}`} />
                  <label htmlFor={`replace-${type}`} className="cursor-pointer block">
                    {isUploading ? (
                      <div className="flex items-center justify-center gap-2">
                        <Loader2 className={`w-4 h-4 animate-spin ${isExpired ? 'text-orange-500' : 'text-red-500'}`} />
                        <span className={`text-sm ${isExpired ? 'text-orange-600' : 'text-red-600'}`}>Uploading…</span>
                      </div>
                    ) : (
                      <>
                        <Upload className={`w-6 h-6 mx-auto mb-1 ${isExpired ? 'text-orange-400' : 'text-red-400'}`} />
                        <p className={`text-sm font-medium ${isExpired ? 'text-orange-600' : 'text-red-600'}`}>Click to select file</p>
                        <p className={`text-xs mt-0.5 ${isExpired ? 'text-orange-400' : 'text-red-400'}`}>Images or PDF, max {maxSizeMB}MB</p>
                      </>
                    )}
                  </label>
                </div>
                {!isUploading && (
                  <button onClick={() => setShowReplace(false)} className="mt-2 text-xs text-slate-500 hover:text-slate-700 underline">Cancel</button>
                )}
                {error && <p className="text-xs text-red-500 mt-1 flex items-center gap-1"><AlertCircle className="w-3 h-3" />{error}</p>}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // Show preview state
  if (previewFile) {
    return (
      <div className="border-2 border-accent-200 rounded-xl overflow-hidden">
        <div className="bg-accent-50 p-3 flex items-center justify-between">
          <span className="text-sm font-medium text-accent-800">Preview</span>
          <button
            onClick={() => setPreviewFile(null)}
            className="p-1 hover:bg-accent-100 rounded"
          >
            <X className="w-4 h-4 text-accent-600" />
          </button>
        </div>
        <div className="p-4 bg-white">
          {previewFile.type.startsWith('image/') ? (
            <img
              src={URL.createObjectURL(previewFile)}
              alt="Preview"
              className="max-h-48 mx-auto rounded-lg"
            />
          ) : (
            <div className="flex flex-col items-center py-8">
              <FileText className="w-16 h-16 text-slate-300 mb-2" />
              <p className="text-sm text-slate-600">{previewFile.name}</p>
            </div>
          )}
        </div>
        <div className="p-3 bg-slate-50 border-t">
          {isUploading ? (
            <div className="flex items-center gap-3">
              <Loader2 className="w-4 h-4 animate-spin text-accent-500" />
              <div className="flex-1">
                <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-accent-500 transition-all duration-300"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </div>
              <span className="text-xs text-slate-500">{Math.round(uploadProgress)}%</span>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button 
                variant="secondary" 
                size="sm" 
                fullWidth
                onClick={() => setPreviewFile(null)}
              >
                Cancel
              </Button>
              <Button 
                variant="accent" 
                size="sm" 
                fullWidth
                onClick={() => handleFileSelect(previewFile)}
              >
                Upload
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Show upload area
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1">
        {label}
      </label>
      {description && (
        <p className="text-xs text-slate-500 mb-2">{description}</p>
      )}
      
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`
          border-2 border-dashed rounded-xl p-6 text-center transition-colors cursor-pointer
          ${isDragging 
            ? 'border-accent-500 bg-accent-50' 
            : 'border-slate-200 hover:border-accent-300 hover:bg-slate-50'
          }
          ${error ? 'border-red-300 bg-red-50' : ''}
        `}
      >
        <input
          type="file"
          accept={acceptedTypes}
          onChange={handleInputChange}
          className="hidden"
          id={`file-upload-${type}`}
        />
        <label htmlFor={`file-upload-${type}`} className="cursor-pointer block">
          <Upload className={`w-8 h-8 mx-auto mb-2 ${error ? 'text-red-400' : 'text-slate-400'}`} />
          <p className={`text-sm font-medium ${error ? 'text-red-600' : 'text-slate-600'}`}>
            Click to upload or drag and drop
          </p>
          <p className="text-xs text-slate-400 mt-1">
            Images or PDF, max {maxSizeMB}MB
          </p>
        </label>
      </div>
      
      {error && (
        <p className="text-xs text-red-500 mt-1 flex items-center gap-1">
          <AlertCircle className="w-3 h-3" />
          {error}
        </p>
      )}
    </div>
  );
};
