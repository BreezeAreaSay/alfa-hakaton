import './DemoNotice.css';

import { Typography } from '@alfalab/core-components/typography';

/** Полоса над шапкой в демо-версии без сервера: где живут данные и как их сбросить. */
export default function DemoNotice() {
    return (
        <div className='demo-notice' role='note' aria-label='Демо-версия'>
            <span className='demo-notice__badge'>Демо</span>
            <Typography.Text view='primary-small' color='secondary-inverted'>
                <Typography.Text view='primary-small' weight='medium' color='primary-inverted'>
                    Демо-версия без сервера: данные хранятся в этом браузере.
                </Typography.Text>{' '}
                Сбросить их можно под учётной записью admin на странице «Конвейер и сбои».
            </Typography.Text>
        </div>
    );
}
