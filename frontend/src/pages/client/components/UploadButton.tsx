import { Button } from '@alfalab/core-components/button';
import { PaperclipMIcon } from '@alfalab/icons-glyph/PaperclipMIcon';
import { useRef } from 'react';

export function UploadButton({
    onFile,
    loading,
    accept = '.pdf,.jpg,.jpeg,.png,.txt,.csv',
    children = 'Прикрепить файл',
    view = 'secondary',
}: {
    onFile: (file: File) => void;
    loading?: boolean;
    accept?: string;
    children?: string;
    view?: 'secondary' | 'accent' | 'primary';
}) {
    const input = useRef<HTMLInputElement>(null);
    return (
        <>
            <input
                ref={input}
                type='file'
                accept={accept}
                hidden={true}
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) onFile(file);
                    event.target.value = '';
                }}
            />
            <Button
                view={view}
                size={48}
                leftAddons={<PaperclipMIcon />}
                loading={loading}
                onClick={() => input.current?.click()}
            >
                {children}
            </Button>
        </>
    );
}
